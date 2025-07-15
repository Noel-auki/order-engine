const firebaseAdmin = require("../config/firebase-admin");
const { pool } = require("../config/db");

const sendNotificationToRestaurant = async (title, body, data, rsid, orderType = "butler", silent = false) => {
    console.log("Sending notification...");
    const ENV = process.env.NODE_ENV;

    const flagQuery = `
    SELECT flags, open_time, close_time, captain_form_fields AS "captainFormFields"
    FROM restaurants 
    WHERE id = $1
`;
    const { rows } = await pool.query(flagQuery, [rsid]);
    const { flags = {}, open_time, close_time, captainFormFields } = rows[0] || {};
    // Compute current IST minutes
    const now = new Date();
    const utc = now.getTime() + now.getTimezoneOffset() * 60000;
    const istNow = new Date(utc + 5.5 * 60 * 60000);
    const nowMinutes = istNow.getHours() * 60 + istNow.getMinutes();

    if (open_time && close_time) {
        const parseMinutes = t => {
            const [hh, mm] = t.split(':');
            return Number(hh) * 60 + Number(mm);
        };
        const openMin = parseMinutes(open_time);
        const closeMin = parseMinutes(close_time);

        // If times aren't identical (00:00–00:00 means always open)
        if (openMin !== closeMin) {
            const inWindow = openMin < closeMin
                ? nowMinutes >= openMin && nowMinutes < closeMin
                : nowMinutes >= openMin || nowMinutes < closeMin;

            if (!inWindow) {
                console.log(`Skipping notification: current IST ${istNow.toTimeString().slice(0, 5)} not in ${open_time}-${close_time}`);
                return;
            }
        }
    }
    const useAssignedTables = flags.newNotificationFlow === true;

    // Check if captainFormFields.redirectToCustomerInfo is true and tableId is provided.
    // If so, check if there are any orders for this table in the restaurant.
    if (data && data.tableId && captainFormFields && captainFormFields.redirectToCustomerInfo === true) {
        try {
            const orderQuery = `
                SELECT COUNT(*) as count 
                FROM orders 
                WHERE restaurant_id = $1 AND table_id = $2
            `;
            const orderResult = await pool.query(orderQuery, [rsid, data.tableId]);
            const orderCount = parseInt(orderResult.rows[0].count, 10);
            // Set target based on whether there are any orders
            data.target = orderCount > 0 ? "order_details" : "customer_info";
        } catch (error) {
            console.error("Error checking orders for table:", error);
        }
    }
    // ─── handle biller notifications ─────────────────────────────────────
    if (orderType === 'biller') {
        const billerTokenQuery = `
      SELECT rpt.token
      FROM restaurant_push_tokens rpt
      JOIN captains c ON rpt.user_id = c.username
      WHERE rpt.restaurantid = $1
        AND c.role = 'biller'
    `;
        const { rows: billerRows } = await pool.query(billerTokenQuery, [rsid]);
        const billerTokens = billerRows.map(r => r.token);

        if (billerTokens.length === 0) {
            console.log('No biller tokens found for restaurant', rsid);
            return;
        }
        let payloadData;
        if (typeof data === 'string') {
        try {
            payloadData = JSON.parse(data);
        } catch (err) {
            console.warn('Invalid JSON in data, falling back to empty object');
            payloadData = {};
        }
        } else if (data && typeof data === 'object') {
        // make a shallow clone so we don't mutate caller's variable
        payloadData = { ...data };
        } else {
        payloadData = {};
        }

        // 2) Add your extra field
        payloadData.target = 'bill_notification';

         // 3) build a "safe" data map where every value is a string
        const safeData = Object.fromEntries(
            Object.entries(payloadData).map(([k, v]) => [
            k,
            typeof v === 'string' ? v : JSON.stringify(v)
            ])
          );

        await sendNotification(
            title,
            body,
            safeData,
            billerTokens,
            orderType,
            silent
        );
        return;
    }

    let tokenQuery;
    let queryParams;
    let registrationTokens;

    if (orderType === "manager" && useAssignedTables) {
        // Query for manager tokens
        const managerTokenQuery = `
          SELECT rpt.token
          FROM restaurant_push_tokens rpt
          JOIN captains c ON rpt.user_id = c.username
          WHERE rpt.restaurantid = $1
            AND c.restaurant_id = $1
            AND c.role = 'manager'
        `;
        const managerQueryParams = [rsid];
        const { rows: managerRows } = await pool.query(managerTokenQuery, managerQueryParams);
        registrationTokens = managerRows.map(row => row.token);
      
        // If a table is specified, check if delayNotifyCaptain is enabled
        if (data && data.tableId) {
          // Query the restaurants's configuration for captainFormFields
          const tableConfigQuery = `
            SELECT captain_form_fields AS "captainFormFields"
            FROM restaurants
            WHERE id = $1
          `;
          const tableConfigParams = [rsid];
          const { rows: tableRows } = await pool.query(tableConfigQuery, tableConfigParams);
          const { captainFormFields } = tableRows[0] || {};
      
          // If delayNotifyCaptain is true, fetch captain tokens assigned to this table
          if (captainFormFields && captainFormFields.delayNotifyCaptain === true) {
            console.log(captainFormFields, "captainFormFields", captainFormFields.delayNotifyCaptain);
            const captainTokenQuery = `
              SELECT token 
              FROM restaurant_push_tokens 
              WHERE restaurantid = $1 
                AND user_id IN (
                  SELECT username 
                  FROM captains 
                  WHERE restaurant_id = $1 
                    AND assigned_tables @> $2::jsonb
                )
            `;
            const captainQueryParams = [rsid, JSON.stringify([data.tableId])];
            const { rows: captainRows } = await pool.query(captainTokenQuery, captainQueryParams);
            const captainTokens = captainRows.map(row => row.token);
      
            // Merge captain tokens with manager tokens (deduplicate if necessary)
            registrationTokens = Array.from(new Set([...registrationTokens, ...captainTokens]));
          }
        }
      
        // Send notification with the combined tokens list
        await sendNotification(title, body, data, registrationTokens, orderType, silent);
        return;
      } else if (useAssignedTables && data && data.tableId) {
        // Existing logic for non-manager notifications: notify the captain(s) assigned to the table
        tokenQuery = `
          SELECT token 
          FROM restaurant_push_tokens 
          WHERE restaurantid = $1 
            AND user_id IN (
              SELECT username 
              FROM captains 
              WHERE restaurant_id = $1 
                AND assigned_tables @> $2::jsonb
            )
        `;
        queryParams = [rsid, JSON.stringify([data.tableId])];
      } else {
        // Fallback: notify all tokens for the restaurant
        tokenQuery = 'SELECT token FROM restaurant_push_tokens WHERE restaurantid = $1';
        queryParams = [rsid];
      }
      
    const { rows: tokens } = await pool.query(tokenQuery, queryParams);
    registrationTokens = tokens.map(row => row.token);

     // Fallback check: if using assigned tables but no tokens were found, fetch all tokens
     if (useAssignedTables && data && data.tableId && registrationTokens.length === 0) {
        console.log("No assigned tokens found, falling back to all tokens");
        const fallbackResult = await pool.query(
            'SELECT token FROM restaurant_push_tokens WHERE restaurantid = $1',
            [rsid]
        );
        registrationTokens = fallbackResult.rows.map(row => row.token);
    }

    if (registrationTokens.length === 0) {
        console.log('No tokens found for push notification');
        return;
    }

    await sendNotification(title, body, data, registrationTokens, orderType, silent);

    const { rows: allRows } = await pool.query(
        'SELECT token FROM restaurant_push_tokens WHERE restaurantid = $1',
        [rsid]
    );
    const allTokens = allRows.map(r => r.token);
    const silentTokens = allTokens.filter(t => !registrationTokens.includes(t));
    console.log(silentTokens, "silentTokens")

    if (silentTokens.length > 0) {
        // empty title/body + orderType="captain" → no sound/vibration/alert
        await sendNotification('', '', data, silentTokens, 'captain', true);
    }
};

const removeTokenFromDatabase = async (token) => {
    try {
        const deleteQuery = `DELETE FROM restaurant_push_tokens WHERE token = $1`;
        await pool.query(deleteQuery, [token]);
        console.log(`Token ${token} removed from database`);
    } catch (error) {
        console.error(`Error removing token ${token} from database:`, error);
    }
};

const sendNotification = async (title, body, data, tokens, orderType, silent = false) => {
    console.log(data, "inside and final")
    console.log(tokens);
    try {
        if (tokens.length === 0) {
            console.log('No tokens available for sending notifications.');
            return;
        }

        let payloadData;
        if (typeof data === 'string') {
            try {
                payloadData = JSON.parse(data);
            } catch (err) {
                console.warn('Invalid JSON in data, falling back to empty object');
                payloadData = {};
            }
        } else if (data && typeof data === 'object') {
            // make a shallow clone so we don't mutate caller's variable
            payloadData = { ...data };
        } else {
            payloadData = {};
        }

        // build a "safe" data map where every value is a string
        const safeData = Object.fromEntries(
            Object.entries(payloadData).map(([k, v]) => [
                k,
                typeof v === 'string' ? v : JSON.stringify(v)
            ])
        );

        const message = {
            notification: {
                title,
                body,
            },
            data: safeData,
            tokens: tokens,
            android: {
                priority: silent ? 'normal' : 'high',
                notification: {
                    sound: silent ? null : 'default',
                    channelId: orderType === 'butler' ? 'butler_channel' : 'captain_channel'
                }
            },
            apns: {
                payload: {
                    aps: {
                        sound: silent ? null : 'default',
                        badge: 1
                    }
                }
            }
        };

        const response = await firebaseAdmin.messaging().sendMulticast(message);

        console.log('Successfully sent message:', response);

        // Handle failures
        if (response.failureCount > 0) {
            const failedTokens = [];
            response.responses.forEach((resp, idx) => {
                if (!resp.success) {
                    failedTokens.push(tokens[idx]);
                    console.log('Failed to send notification to token:', tokens[idx], resp.error);

                    // Check if the error is due to an unregistered device
                    if (resp.error.code === 'messaging/registration-token-not-registered') {
                        removeTokenFromDatabase(tokens[idx]);
                    }
                }
            });

            console.log('List of tokens that caused failures:', failedTokens);
        }
    } catch (error) {
        console.error('Error sending notification:', error);
    }
};

module.exports = {
    sendNotificationToRestaurant,
    removeTokenFromDatabase,
    sendNotification
}; 