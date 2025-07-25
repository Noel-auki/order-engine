const { pool } = require('../config/db');
const { sortVariation } = require('../utils/sortVariation');
const { mergerOrders } = require('../utils/order');
const { sendNotificationToRestaurant } = require('../utils/sendNotifications');
const { insertNotification } = require('../utils/notificationsUtil');
const { completeOrder } = require("../utils/order.js");
/*
// Redis utilities disabled in local context
const { getRedisFieldValue, updateRedisSession, updateAllRedisTableSessions, getTableSessionKey, getRedisFieldsValue } = require("../utils/redis.js");
const redisClient = require("../config/redis");
*/
const NodeCache = require('node-cache');
// const {createTableOTP} = require('./tableOTPController');
const {getAvailedOffers, disableAvailableOffers, generateVolumnOffer} = require('../utils/offerUtils.js');
const {parsePgArray} = require('../utils/array');

// Create a cache instance with a TTL of 600 seconds (10 minutes)
const menuCache = new NodeCache({ stdTTL: 600 });

async function getUniqueDiscountCode(length = 6) {
    const { nanoid } = await import('nanoid');
    return nanoid(length);
}

const getCustomizationKey = (custom) => {
    // Use a sorted string representation for addons to avoid order issues.
    // We assume addons is an object where keys map to arrays.
    const sortedAddons = {};
    if (custom.addons) {
        Object.keys(custom.addons)
            .sort()
            .forEach(key => {
                // sort the addons array by id to ensure consistent ordering.
                sortedAddons[key] = custom.addons[key]
                    .slice()
                    .sort((a, b) => (a.id > b.id ? 1 : -1));
            });
    }
    return JSON.stringify({
        variation: custom.variation,
        addons: sortedAddons
    });
};

const findDifferences = (latestOrder, newOrder) => {
    const updatedItems = {};

    // Process new and modified items.
    Object.keys(newOrder).forEach(itemId => {
        if (!latestOrder[itemId]) {
            // Newly added item: attach an "added" flag and add qtyChange to each customization.
            updatedItems[itemId] = {
                added: true,  // flag indicating this is a new item
                ...newOrder[itemId],
                customizations: newOrder[itemId].customizations.map(custom => ({
                    ...custom,
                    qtyChange: custom.qty  // initial change equals the full quantity
                }))
            };
        } else {
            const currentItem = latestOrder[itemId];
            const newItem = newOrder[itemId];

            const updatedCustomizations = newItem.customizations.map(newCustomization => {
                const oldCustomization = currentItem.customizations.find(c =>
                    getCustomizationKey(c) === getCustomizationKey(newCustomization)
                );
                // For modifications, calculate the difference.
                const qtyChange = oldCustomization ? newCustomization.qty - oldCustomization.qty : newCustomization.qty;
                return {
                    ...newCustomization,
                    qtyChange
                };
            });

            // Filter out customizations with no change.
            const changedCustomizations = updatedCustomizations.filter(c => c.qtyChange !== 0);

            // Only add the item if there is at least one changed customization.
            if (changedCustomizations.length > 0) {
                updatedItems[itemId] = {
                    ...newItem,
                    customizations: changedCustomizations
                };
            }
        }
    });

    // Process deleted items: items present in the latestOrder but missing in newOrder.
    Object.keys(latestOrder).forEach(itemId => {
        if (!newOrder[itemId]) {
            const deletedItem = latestOrder[itemId];
            updatedItems[itemId] = {
                deleted: true,                         // Flag to indicate deletion.
                qtyRemoved: deletedItem.totalQty,      // The entire quantity removed.
                newQty: 0,
                // Provide details for each customization that was removed.
                customizations: deletedItem.customizations.map(custom => ({
                    ...custom,
                    qtyChange: -custom.qty  // Negative value to denote removal.
                }))
            };
        }
    });

    return updatedItems;
};


const attachMenuNames = async (updatedItems, restaurantId, openItemId = null) => {
    // Try to get the mapping from cache.
    let menuMapping = menuCache.get(restaurantId);
    if (!menuMapping) {
        // If not in cache, query the database.
        const menuItemsResult = await pool.query(
            'SELECT id, name FROM menu_items WHERE restaurantid = $1',
            [restaurantId]
        );
        menuMapping = {};
        menuItemsResult.rows.forEach(menuItem => {
            menuMapping[menuItem.id] = menuItem.name;
        });
        // Store in cache.
        menuCache.set(restaurantId, menuMapping);
    }

    // Attach the name property to each updated item, except openItemId
    Object.keys(updatedItems).forEach(itemId => {
        if (itemId === openItemId) return; // skip open item
        if (menuMapping[itemId]) {
            updatedItems[itemId].name = menuMapping[itemId];
        }
    });

    return updatedItems;
};

async function getNextInvoiceNumber(restaurantId) {
    const currentYear = new Date().getFullYear();
    const result = await pool.query(
        'SELECT current_invoice FROM invoice_counters WHERE restaurant_id = $1 AND year = $2',
        [restaurantId, currentYear]
    );
    let newInvoice;
    if (result.rows.length > 0) {
        newInvoice = result.rows[0].current_invoice + 1;
        await pool.query(
            'UPDATE invoice_counters SET current_invoice = $1 WHERE restaurant_id = $2 AND year = $3',
            [newInvoice, restaurantId, currentYear]
        );
    } else {
        newInvoice = 1;
        await pool.query(
            'INSERT INTO invoice_counters (restaurant_id, year, current_invoice) VALUES ($1, $2, $3)',
            [restaurantId, currentYear, newInvoice]
        );
    }
    return newInvoice;
}

const createOrUpdateOrder = async (req, res) => {


    const { restaurantId, tableId, items, instructions, 
        userId, otpCheck, orderType = "Dine In", 
        captainId , selectedOffer = '',isPlacingOffer = false, forceNewOrder = false, orderId: providedOrderId } = req.body;

    const uniqueKey = new Date().getTime(); // Generate a unique key using the current timestamp
    let orderId;
    const sessionKey = `session:${restaurantId}:${tableId}:${userId}`;
    let guestCount = 0;
    // if (userId) {
    //     const guestCountFromSession = await getRedisFieldValue(sessionKey, "guestCount");
    //     if (guestCountFromSession && guestCountFromSession > 0) {
    //         guestCount = guestCountFromSession;
    //     }
    // }
    console.log(orderType, captainId)

    // Auto-assign table when orderType is “captain” (disabled in local context)
    /*
    if (orderType === 'captain' && captainId) {
        await pool.query(
            `UPDATE captains
             SET assigned_tables = CASE
               WHEN NOT (COALESCE(assigned_tables, '[]'::jsonb) @> to_jsonb($1::text))
                 THEN COALESCE(assigned_tables, '[]'::jsonb) || to_jsonb($1::text)
               ELSE assigned_tables
             END
           WHERE captain_id = $2
             AND restaurant_id = $3`,
            [tableId, captainId, restaurantId]
        );
    }
    */

    // Check if eligible for volumn offer
    // if (!isPlacingOffer) {
    //     const volumnOffer = await generateVolumnOffer(restaurantId,tableId,items);

    //     if (volumnOffer && volumnOffer.status) {
    //         res.status(200).json({ status: 'volumn_offer_availble',message: `You have an offer available: Add items worth ₹ ${volumnOffer.amountNeeded} more and get flat ${volumnOffer.discount} off on your bill amount on payment through butler pay. Do you want to continue confirming the cart or add more items?` });
    //         return;
    //     }
    // }

    // if (otpCheck) {
    //     const otpVerified = await getRedisFieldValue(sessionKey, "otpVerified");
    //     if (!otpVerified) {
    //         const createdOtp = await createTableOTP(restaurantId, tableId);
    //         if (createdOtp) {
    //             res.status(200).json({ status: 'otp_verification_required',message: 'OTP verification required', orderId });
    //             return;
    //         }

    //     }
    // }
    try {
        // const tableSessionKey = await getTableSessionKey(restaurantId, tableId); // Disabled table session logic
        const orderResult = await pool.query('SELECT * FROM orders WHERE restaurant_id = $1 AND table_id = $2', [restaurantId, tableId]);


        /* const io = req.app.get('io'); */

        let latestOrder = {};
        let existingInstructions = "";
        
        // If a specific orderId is provided, use it (for scenarios like moving orders or split bills)
        if (providedOrderId) {
            orderId = providedOrderId;
            // Check if this specific order already exists
            const specificOrderResult = await pool.query(
                'SELECT * FROM orders WHERE restaurant_id = $1 AND id = $2', 
                [restaurantId, providedOrderId]
            );
            if (specificOrderResult.rows.length > 0) {
                latestOrder = specificOrderResult.rows[0].json_data.items || {};
                existingInstructions = specificOrderResult.rows[0].instructions || "";
            }
        } else if (orderResult.rows.length > 0 && !forceNewOrder) {
            // Use existing order on the table
            orderId = orderResult.rows[0].id;
            latestOrder = orderResult.rows[0].json_data.items || {};
            existingInstructions = orderResult.rows[0].instructions || "";
        } else {
            // Generate new orderId
            orderId = `${restaurantId}-${tableId}-${uniqueKey}`;
        }

        const openItemIdResult = await pool.query(
            `SELECT openitemid FROM restaurants WHERE id = $1`,
            [restaurantId]
          );
        const openItemId = openItemIdResult.rows[0]?.openitemid || null;
        const transformedItems = transformOpenItems(items, openItemId);
        
        const mergedOrder = mergerOrders(latestOrder, transformedItems);
        //const mergedOrder = mergerOrders(latestOrder, items);

          
        const mergedInstructions = existingInstructions
            ? `${existingInstructions}\n${instructions}` // Append instructions if present
            : instructions || "";

        const updatedItems = findDifferences(latestOrder, mergedOrder);

        const updatedItemIds = Object.keys(updatedItems);

        const petpoojaResult = await pool.query(
            'SELECT ispetpoojaenabled, sendPhoneNumber FROM restaurants WHERE id = $1',
            [restaurantId]
        );


        // Initialize the flag to false by default
        let petpoojaEnabled = false;
        let sendPhoneNumber = false;

        if (petpoojaResult.rows.length > 0) {
            petpoojaEnabled = Boolean(petpoojaResult.rows[0].ispetpoojaenabled);
            sendPhoneNumber = Boolean(petpoojaResult.rows[0].sendphonenumber);
        } else {
            console.warn(`Restaurant with ID ${restaurantId} not found.`);
        }

        // 4) Check if newly added items are active (in stock)
        // if (updatedItemIds.length > 0) {
        //     // Fetch from menu_items to see if 'active' = true
        //     const placeholder = updatedItemIds.map((_, idx) => `$${idx + 1}`).join(', ');
        //     const checkSql = `
        //         SELECT id, name, active
        //         FROM menu_items
        //         WHERE id IN (${placeholder})
        //           AND restaurantid = $${updatedItemIds.length + 1}
        //     `;
        //     // Values array: [ itemId1, itemId2, ..., restaurantId ]
        //     const checkValues = [...updatedItemIds, restaurantId];
        //     const checkResult = await pool.query(checkSql, checkValues);

        //     // Identify which items are inactive
        //     const inactiveItems = checkResult.rows
        //         .filter(row => !row.active)
        //         .map(row => ({ id: row.id, name: row.name }));

        //     // If any items are inactive, return an error
        //     if (inactiveItems.length > 0) {
        //         return res.status(400).json({
        //             message: 'Some items are out of stock.',
        //             inactiveItems
        //         });
        //     } 
        // }
        // if (isOffer) {

        // }


        // Check if we need to create a new order or update existing one
        const shouldCreateNewOrder = (orderResult.rows.length === 0 || forceNewOrder) && !providedOrderId;
        const shouldUpdateExistingOrder = (orderResult.rows.length > 0 && !forceNewOrder) || providedOrderId;
        
        if (shouldCreateNewOrder) {
            // Create new order with generated orderId
            await pool.query(
                'INSERT INTO orders (id, restaurant_id, table_id, assigned_to, created_at, updated_at, json_data, instructions, guest_count) VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, $5, $6, $7) RETURNING id',
                [orderId, restaurantId, tableId, captainId || null, JSON.stringify({ items: mergedOrder }), mergedInstructions, guestCount]
            );
            
            // Notification logic disabled for local DB-only operation
            const updatedItems = findDifferences({}, mergedOrder);
            const updatedItemsWithNames = await attachMenuNames(updatedItems, restaurantId, openItemId);
            await insertNotification({
                restaurantId,
                tableNumber: tableId,
                orderId,
                actionType: 'order_created',
                notificationData: updatedItemsWithNames,
                orderType,
                captainId,
            });
            const notificationData = { orderId, tableId, type: 'order_created', orderType };
            // updateAllRedisTableSessions(restaurantId, tableId, 'orderId', orderId);
            sendNotificationToRestaurant('Order Created', `New order created for table ${tableId}.`, notificationData, restaurantId, orderType);
        
            let msg = `Thanks for your order, it's forwarded to the kitchen. These are your current orders:`;
            res.status(201).json({ 
                message: msg, 
                orderId, 
                status: 'order_confirmed',
                offerFullyAvailed: false,
                offerPartiallyAvailed: false 
             });
        } else if (shouldUpdateExistingOrder) {
            // Check if the specific order exists (when providedOrderId is used)
            let orderExists = false;
            if (providedOrderId) {
                const specificOrderCheck = await pool.query(
                    'SELECT * FROM orders WHERE restaurant_id = $1 AND id = $2',
                    [restaurantId, providedOrderId]
                );
                orderExists = specificOrderCheck.rows.length > 0;
            } else {
                orderExists = orderResult.rows.length > 0;
            }
            
            // If order doesn't exist but we have a provided orderId, create it
            if (!orderExists && providedOrderId) {
                await pool.query(
                    'INSERT INTO orders (id, restaurant_id, table_id, assigned_to, created_at, updated_at, json_data, instructions, guest_count) VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, $5, $6, $7) RETURNING id',
                    [orderId, restaurantId, tableId, captainId || null, JSON.stringify({ items: mergedOrder }), mergedInstructions, guestCount]
                );
                
                // Notification for new order with specific ID
                const updatedItems = findDifferences({}, mergedOrder);
                const updatedItemsWithNames = await attachMenuNames(updatedItems, restaurantId, openItemId);
                await insertNotification({
                    restaurantId,
                    tableNumber: tableId,
                    orderId,
                    actionType: 'order_created',
                    notificationData: updatedItemsWithNames,
                    orderType,
                    captainId,
                });
                const notificationData = { orderId, tableId, type: 'order_created', orderType };
                sendNotificationToRestaurant('Order Created', `New order created for table ${tableId}.`, notificationData, restaurantId, orderType);
            
                let msg = `Thanks for your order, it's forwarded to the kitchen. These are your current orders:`;
                res.status(201).json({ 
                    message: msg, 
                    orderId, 
                    status: 'order_confirmed',
                    offerFullyAvailed: false,
                    offerPartiallyAvailed: false 
                 });
                return;
            }
            
            // Handle offers for existing orders
            const offerResult = await pool.query(
                'SELECT * FROM dynamic_offers WHERE restaurant_id = $1 AND table_id = $2 AND active = true',
                [restaurantId, tableId]
            );
            const offers = offerResult.rows;
            
            // Get the order to check for existing offers
            const orderToCheck = providedOrderId ? 
                (await pool.query('SELECT * FROM orders WHERE restaurant_id = $1 AND id = $2', [restaurantId, providedOrderId])).rows[0] :
                orderResult.rows[0];

            let offerFullyAvailed= false,offerPartiallyAvailed = false;
            if (orderType === 'butler' && offerResult.rows.length !== 0 && !orderToCheck.offer_availed) {
                try {
                    const offerStatus = await getAvailedOffers(mergedOrder,orderId,offers,selectedOffer,restaurantId,tableId);
                    offerFullyAvailed = offerStatus.offerFullyAvailed;
                    offerPartiallyAvailed = offerStatus.offerPartiallyAvailed;
                }
                catch (error) {
                    console.error('Error while availing offer:',error);
                }
            }
            else if (orderType !== 'butler' && offerResult.rows.length !== 0 && !orderToCheck.offer_availed) {
                await disableAvailableOffers(mergedOrder,offers,restaurantId);
            }

            const updatedItemsWithNames = await attachMenuNames(updatedItems, restaurantId, openItemId);
            
            let msg = `Thanks for your order, it's forwarded to the kitchen.\nThese are your current orders:`;
            if (offerFullyAvailed) {
                msg = `Thank you for your order! Your offer will be applied to the final bill when you pay through Butler Pay. You’ll be redirected to the menu shortly.\nHere are your current orders:`
            } 
            else if (offerPartiallyAvailed) {
                msg = `Thank you for your order! Your offer will be applied to the final bill when you pay through Butler Pay.\nHere are your current orders:`

            }
            else if (isPlacingOffer && (!offerFullyAvailed || !offerPartiallyAvailed)) {
                msg = `The offer you’re trying to avail has either already been used at your table or has expired. You’ll be redirected to the menu shortly.\nHere are your current orders:`
                return res.status(200).json({ 
                    message: msg, 
                    orderId, 
                    status: 'offer_expired', 
                    offerFullyAvailed,
                    offerPartiallyAvailed 
                });
            }

            const result = await pool.query(
                `UPDATE orders 
                 SET json_data = $1, instructions = $2, updated_at = CURRENT_TIMESTAMP, assigned_to = $3 
                 WHERE id = $4 
                 RETURNING *`,
                [JSON.stringify({ items: mergedOrder }), mergedInstructions, captainId || null, orderId]
            );

            
            // Disabled notification on update
            await insertNotification({
                restaurantId,
                tableNumber: tableId,
                orderId,
                actionType: 'order-updated',
                notificationData: updatedItemsWithNames,
                orderType,
                captainId,
            });
            const notificationData = { orderId, tableId, type: 'order_update', orderType };
            sendNotificationToRestaurant('Order Updated', `Order updated for table ${tableId}.`, notificationData, restaurantId, orderType);
            

            res.status(200).json({ 
                message: msg, 
                orderId, 
                status: 'order_update', 
                offerFullyAvailed,
                offerPartiallyAvailed 
            });
        }

        // Check if newNotificationFlow flag is enabled for the restaurant
        /*
        const restaurantFlagsResult = await pool.query(
            'SELECT flags FROM restaurants WHERE id = $1',
            [restaurantId]
        );

        let newNotificationFlag = false;
        if (restaurantFlagsResult.rows.length > 0) {
            const flags = restaurantFlagsResult.rows[0].flags || {};
            newNotificationFlag = Boolean(flags.newNotificationFlow);
        }

        if (newNotificationFlag) {
            await checkAndTriggerBreadBasketForFood(orderId, mergedOrder, restaurantId, tableId);
        } else {
            console.log(`Skipping bread basket notification for restaurant ${restaurantId}: newNotificationFlow disabled.`);
        }
        */


        /* setImmediate(() => {}); // External integrations skipped */
    } catch (error) {
        console.error('Error creating or updating order:', error);
        res.status(500).json({ message: 'Error updating or placing the order.', status: 'order_failed' });
    }
};

exports.createOrUpdateOrder = createOrUpdateOrder;

function transformOpenItems(items, openItemId) {
    const transformed = {};
    for (const [id, itemData] of Object.entries(items)) { 
        // Check if the id starts with openItemId followed by underscore
        if (openItemId && id.startsWith(`${openItemId}_`) && itemData.name && itemData.customizations?.length > 0) {
            // Get price from the first customization
            const customization = itemData.customizations[0];
            
            // Convert name to camelCase and remove special characters
            const cleanName = itemData.name
                .toLowerCase()
                .replace(/[^a-zA-Z0-9 ]/g, '')  // Remove special characters
                .replace(/\s+(.)/g, (match, group) => group.toUpperCase())  // Convert to camelCase
                .replace(/\s/g, '');  // Remove remaining spaces
            
            // Create unique ID by combining original ID, cleaned name, and price
            const uniqueId = `${openItemId}_${cleanName}_${customization.price}`;
            
            transformed[uniqueId] = {
                name: itemData.name,
                customizations: itemData.customizations
            };
        } else {
            console.log("Open Item Not Found");
            transformed[id] = itemData;
        }
    }
    return transformed;
}

exports.offerOrder = async (req, res) => {

    const { restaurantId, tableId, items, userId, selectedOffer = '' } = req.body;
    const lockKey = `offer_order_lock_${restaurantId}_${tableId}`;
    try {
        // Add the Redis lock right before sending the request to Petpooja

        // Try to acquire the lock for 30 seconds
        // const lockAcquired = await redisClient.set(lockKey, userId, { NX: true, EX: 30 });

        // console.log(`Lock acquired for offer ordering ${lockKey}?`, lockAcquired);
        // if (!lockAcquired) {
        //     // If the lock exists, an order is already in process for this restaurant/table.
        //     return res.status(200).json({ status: "table_offer_locked",message: 'Table is currently locked for ordering offer since someone else seems to be ordering currently. Please try again shortly.' });
        // }

    }
    catch (error) {
        console.error("Unable to acquire offer order lock.")
    }

    try {
        req.body.items = items;
        req.body.instructions = "";
        req.body.otpCheck = true;
        req.body.orderType = "butler";
        req.body.selectedOffer = selectedOffer;
        req.body.isPlacingOffer = true;
    
        await createOrUpdateOrder(req, res);
        // let otpVerified = await getRedisFieldValue(sessionKey,'otpVerified');

        // if (!otpVerified) {
        //     const createdOtp = await createTableOTP(restaurantId,tableId);
        //     if (createdOtp) {
        //         res.status(200).json({ status: 'otp_verification_required',message: 'OTP verification required' });
        //         return;
        //     }
        // }
    
        // const offerResult = await pool.query(
        //     'SELECT * FROM dynamic_offers WHERE restaurant_id = $1 AND table_id = $2 AND active = true',
        //     [restaurantId, tableId]
        // );
        // console.log(offerResult.rows,"offerResult.rows");
        // if (offerResult.rows.length === 0) {
    
        //     return res.status(200).json({ status: 'offer_not_valid' });
        // }
    
        // const offers = offerResult.rows;
        // let isOfferAvailed = false;
        // try {
        //     isOfferAvailed = await getAvailedOffers(cart,offers,selectedOffer,restaurantId,tableId);
        // }
        // catch (error) {
    
        // }

                
        // await pool.query(
        //     'UPDATE dynamic_offers SET active = false WHERE restaurant_id = $1 AND table_id = $2',
        //     [restaurantId, tableId]
        // );

    }

    catch (error) {
        return res.status(200).json({ status: "ordering_issue",message: 'Sorry we ran into an issue while ordering, please try again latter.' });
    }
    finally {
        // Release the lock if it is still held by this process
        // try {
        //     const currentValue = await redisClient.get(lockKey);
        //     if (currentValue === userId) {
        //         await redisClient.del(lockKey);
        //     }
        // }
        // catch (error) {
        //     console.error("Unable to release offer lock");
        // }

    }
};

exports.fetchOrder = async (req, res) => {
    const { restaurantId, tableId } = req.params;
    try {
        const orderResult = await pool.query('SELECT * FROM orders WHERE restaurant_id = $1 AND table_id = $2', [restaurantId, tableId]);
        const tempOrderResult = await pool.query('SELECT * FROM tempOrders WHERE restaurant_id = $1 AND table_id = $2', [restaurantId, tableId]);
        if (orderResult.rows.length === 0 && tempOrderResult.rows.length === 0) {
            res.status(404).json({ message: 'Order not found' });
        } else {
            const confirmedOrdersItems = orderResult.rows[0]?.json_data.items || {};
            const tempOrdersItems = tempOrderResult.rows[0]?.json_data.items || {};
            const items = mergerOrders(confirmedOrdersItems, tempOrdersItems);
            res.json(items);
        }
    } catch (error) {
        console.error('Error fetching order:', error);
        res.status(500).json({ error: error.message });
    }
};

exports.fetchActiveOrders = async (req, res) => {
    const { restaurantId } = req.params;

    try {
        // Fetch all orders for the restaurant
        const activeOrdersResult = await pool.query(`
            SELECT * FROM orders 
            WHERE restaurant_id = $1
        `, [restaurantId]);

        const orders = activeOrdersResult.rows;
        const itemIds = [];

        // Process menu items for each order
        orders.forEach(order => {
            const items = order.json_data.items;
            Object.keys(items).forEach(itemId => itemIds.push(itemId));
        });

        let menuItemsMap = {};
        if (itemIds.length > 0) {
            const menuItemsResult = await pool.query(`
                SELECT id, name FROM menu_items WHERE id = ANY($1)
            `, [itemIds]);

            menuItemsResult.rows.forEach(menuItem => {
                menuItemsMap[menuItem.id] = menuItem.name;
            });
        }

        // Update each order with the menu item names
        orders.forEach(order => {
            const items = order.json_data.items;
            Object.keys(items).forEach(itemId => {
                items[itemId].name = items[itemId].name || menuItemsMap[itemId] || 'Unknown Item';
            });
        });

        // Get unique table numbers from the orders (table_id equals notifications.table_number)
        const tableNumbers = [...new Set(orders.map(order => order.table_id))];

        // Fetch active notifications for these table numbers in the restaurant
        const notificationsResult = await pool.query(`
            SELECT * FROM notifications 
            WHERE restaurant_id = $1
              AND table_number = ANY($2)
              AND active = true
        `, [restaurantId, tableNumbers]);

        const notifications = notificationsResult.rows;

        // Determine order status based on the notifications
        orders.forEach(order => {
            // Filter notifications matching the order's table number
            const orderNotifications = notifications.filter(n => n.table_number === order.table_id);

            // Default status (adjust as needed)
            let status = 'delivered';

            // Check if any notification requires calling the waiter
            if (
                orderNotifications.some(n => n.action_type === 'qr_scanner') ||
                orderNotifications.some(n => n.action_type === 'bread_basket_notification') ||
                orderNotifications.some(n => n.action_type ===  'order-reminder',) 
            ) {
                status = 'bread_basket';
            } else if (orderNotifications.some(n => [
                'call_waiter',
                'request_water',
                'pay_cash',
                'swipe_card',
                'petpooja_bill_generation_failed',
                'petpooja_payment_failed',
                'petpooja_order_failed',
                'issue_reported',
                'missing_items_notification',
                'otp_requested',
                'negative_review',
                'bill_already_generated',
                'pay_bill',
                'delayed_items_notification',
            ].includes(n.action_type))) {
                status = 'call_waiter';
            } else if (orderNotifications.some(n =>
                ['order_created', 'order-updated'].includes(n.action_type) && n.order_id === order.id
            )) {
                status = 'to_be_delivered';
            }


            order.orderStatus = status;
        });
        const orderIds = orders.map(order => order.id);

        // Query the petpooja_order_failures table 
        // to check for active failure records for these order IDs.
        const failedOrdersResult = await pool.query(
            `SELECT DISTINCT order_id FROM petpooja_order_failures
             WHERE order_id = ANY($1)
               AND active = true`,
            [orderIds]
        );

        // Create a Set of order IDs that have active failure records
        const failedOrderIds = new Set(failedOrdersResult.rows.map(row => row.order_id));

        // Add the isFailedOrder flag to each order based on the existence of a failure record
        orders.forEach(order => {
            order.isFailedOrder = failedOrderIds.has(order.id);
        });

        res.json(orders);
    } catch (error) {
        console.error('Error fetching active orders:', error);
        res.status(500).json({ error: error.message });
    }
};

exports.completeOrder = async (req, res) => {
    const { restaurantId, tableId } = req.params;
    const { total, paymentMethod, orderId } = req.body;
    const isCompleted = await completeOrder(restaurantId, tableId, total, (paymentMethod ? paymentMethod : ''), '', '', orderId);

    if (isCompleted) {
        await pool.query(
            `UPDATE captains
             SET assigned_tables = COALESCE(assigned_tables, '[]'::jsonb) - $1
           WHERE restaurant_id = $2`,
            [tableId, restaurantId]
        );
        return res.status(200).json({ message: 'Order moved to completed orders successfully' });
    } else {
        return res.status(404).json({ message: 'Order not found' });
    }

};

exports.fetchCompletedOrders = async (req, res) => {
    const { restaurantId } = req.params;
    try {
        const completedOrdersResult = await pool.query(
            'SELECT * FROM completed_orders WHERE restaurant_id = $1',
            [restaurantId]
        );

        const completedOrders = completedOrdersResult.rows;
        const itemIds = [];
        completedOrders.forEach(completedOrder => {
            const items = completedOrder.json_data.items;
            Object.keys(items).forEach(itemId => itemIds.push(itemId));
        });

        if (itemIds.length > 0) {
            const menuItemsResult = await pool.query(`
                SELECT id, name FROM menu_items WHERE id = ANY($1)
            `, [itemIds]);

            const menuItemsMap = {};
            menuItemsResult.rows.forEach(menuItem => {
                menuItemsMap[menuItem.id] = menuItem.name;
            });

            // Add the item name to each item in json_data
            completedOrders.forEach(completedOrder => {
                const items = completedOrder.json_data.items;
                Object.keys(items).forEach(itemId => {
                    items[itemId].name = menuItemsMap[itemId] || items[itemId].name || 'Unknown Item';
                });
            });
        }

        res.json(completedOrders);

    } catch (error) {
        console.error('Error fetching completed orders:', error); // Log the error to the console
        res.status(500).json({ error: error.message });
    }
};

exports.removeItemFromOrder = async (req, res) => {
    // const { restaurantId, tableId, itemId, variation, orderType } = req.params;
    const { restaurantId, tableId, itemId, addons, variationId } = req.body;
    let orderType = req.query;
    if (!orderType) {
        orderType = "captain";
    }

    try {
        const orderResult = await pool.query('SELECT * FROM orders WHERE restaurant_id = $1 AND table_id = $2', [restaurantId, tableId]);
        if (orderResult.rows.length === 0) {
            return res.status(404).json({ message: 'Order not found' });
        }

        const order = orderResult.rows[0];
        const originalItems = JSON.parse(JSON.stringify(order.json_data.items));
        const items = order.json_data.items;

        if (!items[itemId]) {
            return res.status(404).json({ message: 'Item not found in order' });
        }

        // Helper to check if two arrays contain the same elements (order independent)
        function arraysEqual(a, b) {
            if (a.length !== b.length) return false;
            const sortedA = [...a].sort();
            const sortedB = [...b].sort();
            for (let i = 0; i < sortedA.length; i++) {
                if (sortedA[i] !== sortedB[i]) return false;
            }
            return true;
        }

        // Inside your removeItemFromOrder function (or similar), when filtering customizations:
        const updatedCustomizations = items[itemId].customizations.filter((customization) => {
            // Get keys from the customization's addons and variation objects.
            const customizationAddonsKeys = customization.addons ? Object.keys(customization.addons) : [];
            const customizationVariationKeys = customization.variation ? Object.keys(customization.variation) : [];

            let remove = false;

            // Case 1: Both variationId and addons are provided.
            if (variationId && Array.isArray(addons) && addons.length > 0) {
                if (
                    customization.variation &&
                    customization.variation.id === variationId &&
                    arraysEqual(customizationAddonsKeys, addons)
                ) {
                    remove = true;
                }
            }
            // Case 2: Only variationId is provided (addons is null/empty).
            else if (variationId && (!addons || (Array.isArray(addons) && addons.length === 0))) {
                if (
                    customization.variation &&
                    customization.variation.id === variationId &&
                    (!customization.addons || Object.keys(customization.addons).length === 0)
                ) {
                    remove = true;
                }
            }
            // Case 3: Only addons is provided (variationId is not provided or empty).
            else if ((!variationId || variationId === "") && Array.isArray(addons) && addons.length > 0) {
                if (
                    customization.addons &&
                    arraysEqual(customizationAddonsKeys, addons) &&
                    (!customization.variation || Object.keys(customization.variation).length === 0)
                ) {
                    remove = true;
                }
            }
            // Case 4: Neither variationId nor addons provided.
            else if ((!variationId || variationId === "") && (!addons || (Array.isArray(addons) && addons.length === 0))) {
                if (
                    (!customization.addons || Object.keys(customization.addons).length === 0) &&
                    (!customization.variation || Object.keys(customization.variation).length === 0)
                ) {
                    remove = true;
                }
            }

            return !remove; // Keep customization if it doesn't match the removal criteria.
        });

        // Then update the order with the filtered customizations:
        items[itemId].customizations = updatedCustomizations;

        if (updatedCustomizations.length === 0) {
            delete items[itemId];
        } else {
            // items[itemId].customizations = updatedVariations;
            items[itemId].totalQty = updatedCustomizations.reduce((total, custom) => total + custom.qty, 0);
        }

        await pool.query('UPDATE orders SET json_data = $1 WHERE id = $2', [JSON.stringify({ items }), order.id]);

        // const updatedItems = findDifferences(originalItems, items);
        // const updatedItemsWithNames = await attachMenuNames(updatedItems, restaurantId);
        // const notification = await insertNotification({
        //     restaurantId: restaurantId,
        //     tableNumber: tableId,
        //     orderId: order.id,
        //     actionType: 'order-updated',
        //     notificationData: updatedItemsWithNames,
        //     change: 'remove-item',
        //     orderType: orderType,
        // });


        // const io = req.app.get('io');

        res.status(200).json({ message: 'Item removed successfully' });
    } catch (error) {
        console.error('Error removing item from order:', error);
        res.status(500).json({ error: error.message });
    }
};

exports.createOrUpdateTempOrder = async (req, res) => {
    const { restaurantId, tableId, items } = req.body;
    const uniqueKey = new Date().getTime();
    let orderId = '';

    const orderResult = await pool.query('SELECT * FROM tempOrders WHERE restaurant_id = $1 AND table_id = $2', [restaurantId, tableId]);

    let latestOrder = {};
    if (orderResult.rows.length > 0) {
        orderId = orderResult.rows[0].id; // Use existing orderId
        latestOrder = orderResult.rows[0].json_data.items || {};
    } else {
        orderId = `${restaurantId}-${tableId}-${uniqueKey}`; // Generate new orderId
    }

    const openItemResult = await pool.query('SELECT openItemId FROM restaurants WHERE id = $1', [restaurantId]);
    const openItemId = openItemResult.rows[0]?.openitemid || null;
    const processedItems = transformOpenItems(items, openItemId);

    const mergedOrder = mergerOrders(latestOrder, processedItems);


    if (orderResult.rows.length === 0) {
        await pool.query(
            'INSERT INTO tempOrders (id, restaurant_id, table_id, created_at, updated_at, json_data) VALUES ($1, $2, $3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, $4)',
            [orderId, restaurantId, tableId, JSON.stringify({ items: mergedOrder })]
        );
        res.status(201).json({ orderId });
    }
    else {
        await pool.query(
            'UPDATE tempOrders SET json_data = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
            [JSON.stringify({ items: mergedOrder }), orderId]
        );
        res.status(200).json({ message: 'Order updated successfully', orderId });
    }
};

exports.updateTempOrder = async (req, res) => {
    const { restaurantId, tableId, items } = req.body;
    const orderResult = await pool.query('SELECT * FROM tempOrders WHERE restaurant_id = $1 AND table_id = $2', [restaurantId, tableId]);

    let orderId = '';
    if (orderResult.rows.length > 0) {
        orderId = orderResult.rows[0].id;
    } else {
        res.status(404).json({ message: 'Order missing' });
        return;
    }

    if (Object.keys(items) > 0) {
        await pool.query(
            'UPDATE tempOrders SET json_data = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
            [JSON.stringify({ items: items }), orderId]
        );
    }
    else {
        await pool.query('DELETE FROM tempOrders WHERE id = $1', [orderId]);
    }



    res.status(200).json({ message: 'Order updated successfully', orderId });


}

exports.cancelOrder = async (req, res) => {
    const { orderId } = req.params;

    try {
        await pool.query('DELETE FROM tempOrders WHERE id = $1', [orderId]);
        res.status(200).json({ message: 'Order canceled successfully' });
    } catch (error) {
        console.error('Error canceling order:', error);
        res.status(500).json({ error: error.message });
    }
};

exports.moveOrderToMain = async (req, res) => {
    const { orderId } = req.body;

    try {
        await pool.query('BEGIN');

        // Fetch the order from tempOrders
        const tempOrderResult = await pool.query(
            'SELECT * FROM tempOrders WHERE id = $1',
            [orderId]
        );

        if (tempOrderResult.rows.length === 0) {
            await pool.query('ROLLBACK');
            return res.status(404).json({ message: 'Temp order not found' });
        }

        const tempOrder = tempOrderResult.rows[0];
        const { json_data } = tempOrder;

        const items = json_data.items;


        req.body.items = items;
        req.body.restaurantId = tempOrder.restaurant_id;
        req.body.tableId = tempOrder.table_id;

        await exports.createOrUpdateOrder(req, res);

        await pool.query('DELETE FROM tempOrders WHERE id = $1', [tempOrder.id]);

        await pool.query('COMMIT');
    } catch (error) {
        await pool.query('ROLLBACK');
        console.error('Error moving order to main orders:', error);
        res.status(500).json({ error: error.message });
    }
};

exports.fetchTempOrder = async (req, res) => {
    const { orderId } = req.params;

    try {
        const tempOrderResult = await pool.query(
            'SELECT * FROM tempOrders WHERE id = $1',
            [orderId]
        );

        if (tempOrderResult.rows.length === 0) {
            return res.status(404).json({ message: 'Temp order not found' });
        }

        res.status(200).json(tempOrderResult.rows[0]);
    } catch (error) {
        console.error('Error fetching temp order:', error);
        res.status(500).json({ error: error.message });
    }
};

exports.getItemDetails = async (req, res) => {
    const { itemId, restaurantId } = req.params;

    try {
        const result = await pool.query(
            'SELECT name, isVeg FROM menu_items WHERE id = $1 AND restaurantId = $2',
            [itemId, restaurantId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Item not found' });
        }

        res.json(result.rows[0]);
    } catch (error) {
        console.error('Error fetching item details:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};

exports.fetchOrdersByTable = async (req, res) => {
    const { restaurantId, tableId } = req.params;

    try {
        const result = await pool.query(
            'SELECT * FROM tempOrders WHERE restaurant_id = $1 AND table_id = $2',
            [restaurantId, tableId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'No orders found' });
        }

        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching orders:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};

exports.deleteItemFromTempOrder = async (req, res) => {
    const { itemId } = req.params;

    try {
        const result = await pool.query(
            'SELECT json_data FROM tempOrders WHERE json_data::text LIKE $1',
            [`%${itemId}%`]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Item not found in temp orders' });
        }

        const tempOrder = result.rows[0];
        const items = tempOrder.json_data.items;

        delete items[itemId];

        await pool.query(
            'UPDATE tempOrders SET json_data = $1 WHERE json_data::text LIKE $2',
            [JSON.stringify({ items }), `%${itemId}%`]
        );

        res.status(200).json({ message: 'Item removed successfully' });
    } catch (error) {
        console.error('Error removing item from temp order:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};

exports.updateItemQuantity = async (req, res) => {
    const { itemId } = req.params;
    const { quantity } = req.body;

    try {
        const result = await pool.query(
            `UPDATE tempOrders
        SET json_data = jsonb_set(json_data, '{items,${itemId},customizations,0,qty}', to_jsonb($1::int))
        WHERE json_data->'items'->'${itemId}' IS NOT NULL`,
            [quantity]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Item not found' });
        }

        res.status(200).json({ message: 'Quantity updated successfully' });
    } catch (error) {
        console.error('Error updating quantity:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};

exports.printBill = async (req, res) => {
    const { orderId, restaurantId } = req.body;
    try {
        // Fetch the order for the given orderId and restaurantId
        const orderResult = await pool.query(
            'SELECT * FROM orders WHERE id = $1 AND restaurant_id = $2',
            [orderId, restaurantId]
        );

        if (orderResult.rows.length === 0) {
            res.status(404).json({ message: 'Order not found' });
            return;
        }

        const order = orderResult.rows[0];

        // If invoice number doesn't exist, generate and update it
        if (!order.invoice_number) {
            const invoiceNumber = await getNextInvoiceNumber(restaurantId);
            await pool.query(
                'UPDATE orders SET invoice_number = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
                [invoiceNumber, orderId]
            );
            order.invoice_number = invoiceNumber;
        }

        // Now that order.invoice_number is set, trigger the print process
        res.status(200).json({
            message: 'Invoice ready for printing',
            invoice_number: order.invoice_number
        });
    } catch (error) {
        console.error('Error printing bill:', error);
        res.status(500).json({ message: 'Error processing the print request.' });
    }
};

exports.updateReservation = async (req, res) => {
    const { orderId } = req.params;
    const { isreservation } = req.body; // expected boolean value
  
    try {
      // If isreservation is not provided, default to false
      const value = typeof isreservation !== 'undefined' ? isreservation : false;
  
      const result = await pool.query(
        `UPDATE orders 
           SET isreservation = $1
         WHERE id = $2 
         RETURNING *`,
        [value, orderId]
      );
  
      if (result.rowCount === 0) {
        return res.status(404).json({ message: 'Order not found' });
      }
  
      res.status(200).json({
        message: 'Reservation updated successfully',
        order: result.rows[0]
      });
    } catch (error) {
      console.error('Error updating reservation:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  };
  
exports.updateDisableServiceCharge = async (req, res) => {
    const { orderId } = req.params;
    const { disable_service_charge, tableId, restaurantId } = req.body; // expected boolean value
  
    try {
      // Default to false if not provided
      const value = typeof disable_service_charge !== 'undefined' ? disable_service_charge : false;
  
      const result = await pool.query(
        `UPDATE orders 
           SET disable_service_charge = $1
         WHERE id = $2 
         RETURNING *`,
        [value, orderId]
      );
  
      if (result.rowCount === 0) {
        return res.status(404).json({ message: 'Order not found' });
      }
      // await sendNotificationToRestaurant(
      //   '',
      //   '',
      //   {
      //     tableId: String(tableId)
      //   },
      //   restaurantId,
      //   'captain',
      //   true,
      // );
  
      res.status(200).json({
        message: 'Service charge flag updated successfully',
        order: result.rows[0]
      });
    } catch (error) {
      console.error('Error updating service charge flag:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  };
  
const checkIfAnyFoodItem = async (itemIds, restaurantId, orderId) => {
    try {
        const query = `
        SELECT DISTINCT delivery_group 
        FROM petpooja_categories 
        WHERE restaurantid = $1 
          AND items && $2::text[];
      `;
        const itemIdsAsStrings = itemIds.map(String);
        const result = await pool.query(query, [restaurantId, itemIdsAsStrings]);

        if (result.rows.length === 0) {
            console.warn("petpooja_categories not found or empty for restaurant", restaurantId);
            return null;
        }

        // Check if a drink group is present among the items.
        const hasDrink = result.rows.some(row => row.delivery_group === 'drinks');
        
        // If a drink is present, verify its delivery status.
        if (hasDrink) {
            // Query to check for undelivered drink items for this order.
            const drinkQuery = `
              SELECT COUNT(*) as count 
              FROM order_customization_deliveries
              WHERE order_id = $1 
                AND delivered = false 
                AND item_id IN (
                  SELECT unnest(items) 
                  FROM petpooja_categories 
                  WHERE delivery_group = 'drinks'
                    AND restaurantid = $2
                )
            `;
            const drinkResult = await pool.query(drinkQuery, [orderId, restaurantId]);
            const undeliveredDrinks = parseInt(drinkResult.rows[0].count, 10);
            // If any drink is undelivered, do not trigger bread basket notification.
            if (undeliveredDrinks > 0) {
                return false;
            }
        }

        // Otherwise, return true if there is at least one non-drink item.
        return result.rows.some(row => row.delivery_group !== 'drinks');
    } catch (error) {
        console.error("Error accessing petpooja_categories, exiting bread basket notification:", error);
        return null;
    }
};


const checkAndTriggerBreadBasketForFood = async (orderId, mergedOrder, restaurantId, tableId) => {
    const itemIds = Object.keys(mergedOrder).map(id => parseInt(id, 10)); // Convert keys to numbers if needed.
    // const foodExists = await checkIfAnyFoodItem(itemIds, restaurantId, orderId);
    const foodExists = true;

    // If checkIfAnyFoodItem returns null, exit this helper function.
    if (foodExists === null) {
        return;
    }

    if (foodExists) {
        // Check if a bread basket notification already exists for this order.
        const notiQuery = `
        SELECT COUNT(*) AS count 
        FROM notifications 
        WHERE order_id = $1 
          AND action_type = 'bread_basket_notification';
      `;
        const notiResult = await pool.query(notiQuery, [orderId]);
        const notiCount = parseInt(notiResult.rows[0].count, 10);
        if (notiCount === 0) {
            // Insert the bread basket notification.
            await insertNotification({
                restaurantId: restaurantId,
                tableNumber: tableId,
                orderId: orderId,
                actionType: 'bread_basket_notification',
                notificationData: JSON.stringify({ message: "Bread Basket Delivery Request" })
            });
            // Send the push notification to the captain.
            await sendNotificationToRestaurant(
                "Bread Basket Delivery Request",
                `Please deliver the bread basket to the table: ${tableId}`,
                { tableId: tableId, missingItems: JSON.stringify(["Bread Basket"]) },
                restaurantId,
                'butler'
            );
            console.log(`Bread basket notification triggered for food order ${orderId} on table ${tableId}`);
        }
    }
};

