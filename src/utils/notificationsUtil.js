const { pool } = require('../config/db');

const insertNotification = async ({ restaurantId, tableNumber, actionType, captainId = null, notificationData = null, orderId = null, change = null, orderType = null }) => {
    let kotNumber = null;
    if (actionType === 'order_created' || (actionType === 'order-updated' && (!change || change !== 'remove-item'))) {
        try {
            const result = await pool.query(
                `SELECT COALESCE(MAX(kot_number), 0) as max_kot
                FROM notifications 
                WHERE restaurant_id = $1 AND notification_time::date = CURRENT_DATE`,
                [restaurantId]
            );
            const maxKot = parseInt(result.rows[0].max_kot, 10);
            kotNumber = maxKot + 1;
        } catch (error) {
            console.error("Error retrieving max kot_number:", error.message);
            throw error;
        }
    }

    let activeFlag = true;

    if (actionType !== 'order_created' && actionType !== 'order-updated') {
        try {
            await pool.query(
                `UPDATE notifications 
                SET active = false,
                updated_at = NOW()
                WHERE restaurant_id = $1 AND table_number = $2 AND action_type = $3 AND active = true`,
                [restaurantId, tableNumber, actionType]
            );
        } catch (error) {
            console.error("Error updating similar active notifications:", error.message);
            throw error;
        }
    }

    const query = `
        INSERT INTO notifications (
            captain_id,
            restaurant_id,
            table_number,
            action_type,
            notification_time,
            notification_data,
            order_id,
            kot_number,
            order_type,
            active
        )
        VALUES ($1, $2, $3, $4, NOW(), $5, $6, $7, $8, $9)
        RETURNING notification_id;
    `;
    const values = [captainId, restaurantId, tableNumber, actionType, notificationData, orderId, kotNumber, orderType, activeFlag];

    try {
        const result = await pool.query(query, values);
        const notificationRecord = result.rows[0];

        if ((actionType === 'order_created' || actionType === 'order-updated') && notificationData && typeof notificationData === 'object') {
            for (const itemId in notificationData) {
                if (notificationData.hasOwnProperty(itemId)) {
                    const item = notificationData[itemId];
                    if (item.customizations && Array.isArray(item.customizations)) {
                        for (const customization of item.customizations) {
                            await pool.query(
                                `INSERT INTO order_customization_deliveries
                                (notification_id, order_id, item_id, delivered, customization_details)
                                VALUES ($1, $2, $3, $4, $5)`,
                                [notificationRecord.notification_id, orderId, itemId, false, JSON.stringify(customization)]
                            );
                        }
                    }
                }
            }
        }

        return notificationRecord;
    } catch (error) {
        console.error("Error inserting notification and customizations:", error.message);
        throw error;
    }
};

module.exports = { insertNotification }; 