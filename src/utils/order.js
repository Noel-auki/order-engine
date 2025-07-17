const {pool} = require('../config/db');
const { sortVariation,sortAddons } = require('./sortVariation');
const { sendNotificationToRestaurant } = require('./sendNotifications');
const redisClient = require("../config/redis");

const mergerOrders = (latestOrder, items) => {
    // Deep clone the latest order using structuredClone
    const latestOrderClone = structuredClone(latestOrder);

    // Merge the orders
    const mergedOrder = { ...latestOrderClone };

    Object.keys(items).forEach(itemId => {
        const currentCartItem = items[itemId];

        if (!mergedOrder[itemId]) {
            mergedOrder[itemId] = {
                name: currentCartItem.name || "", // Preserve name for open items
                customizations: [...currentCartItem.customizations]
            };            
        } else {
            const orderItem = mergedOrder[itemId];

            currentCartItem.customizations.forEach(cartCustomization => {
                const sortedCartVariation = sortVariation(cartCustomization.variation);
                const sortedCartAddons = sortAddons(cartCustomization.addons);
                
                // Find matching customization by both variation and addons
                const existingCustomizationIndex = orderItem.customizations.findIndex(
                    (c) => 
                        sortVariation(c.variation) === sortedCartVariation &&
                        sortAddons(c.addons) === sortedCartAddons
                );

                if (existingCustomizationIndex > -1) {
                    orderItem.customizations[existingCustomizationIndex].qty += cartCustomization.qty;
                } else {
                    orderItem.customizations.push({ ...cartCustomization });
                }
            });
        }
    });

    return mergedOrder;
};

const tableHasOrder = async (restaurantId, tableId) => {
    try {
        const orderResult = await pool.query('SELECT * FROM orders WHERE restaurant_id = $1 AND table_id = $2', [restaurantId, tableId]);
        const tempOrderResult = await pool.query('SELECT * FROM tempOrders WHERE restaurant_id = $1 AND table_id = $2', [restaurantId, tableId]);
        if (orderResult.rows.length === 0 && tempOrderResult.rows.length === 0) {
            return {}
        }
        const confirmedOrdersItems = orderResult.rows[0]?.json_data.items || {};
        const tempOrdersItems = tempOrderResult.rows[0]?.json_data.items || {};
        const items = mergerOrders(confirmedOrdersItems,tempOrdersItems);
        return items;
    } catch (error) {
        console.error('Error fetching order:', error);
        return {};
    }
}

const getTableOrder = async (restaurantId, tableId) => {
    const orderResult = await pool.query('SELECT * FROM orders WHERE restaurant_id = $1 AND table_id = $2', [restaurantId, tableId]);
    if (orderResult.rows.length === 0) {
        return {}
    }
    return orderResult.rows[0]
}

const getTableGuestCount = async (restaurantId, tableId) => {
    try {
        const orderResult = await pool.query('SELECT * FROM orders WHERE restaurant_id = $1 AND table_id = $2', [restaurantId, tableId]);
        if (orderResult.rows.length === 0) {
            return 0
        }
        const guestCount = orderResult.rows[0].guest_count;
        if (!guestCount) {
            return 0;
        }
        return guestCount;
    } catch (error) {
        console.error('Error fetching order:', error);
        return {};
    }
}

const getTableOrderDetails = async (restaurantId, tableId) => {
    try {
        const orderResult = await pool.query('SELECT * FROM orders WHERE restaurant_id = $1 AND table_id = $2', [restaurantId, tableId]);
        if (orderResult.rows.length === 0) {
            return null
        }
        return {
            id: orderResult.rows[0]?.id,
            items: orderResult.rows[0]?.json_data.items,
            readyForReview: orderResult.rows[0]?.readyforreview
        };
    } catch (error) {
        console.error('Error fetching order:', error);
        return null;
    }
}

const getFormatedShortOrderCart = async (items) => {
    if (!items) {
        return [];
    }

    // Extract item IDs from the merged orders
    const itemIds = Object.keys(items);

    // Fetch item names from menu_items table in a single query
    const menuItemsResult = await pool.query('SELECT id, name, description, price FROM menu_items WHERE id = ANY($1)', [itemIds]);

    // Create a map of itemId -> { name, description, price }
    const itemDetailsMap = {};
    menuItemsResult.rows.forEach(item => {
        itemDetailsMap[item.id] = {
            name: item.name,
            description: item.description,
            price: item.price
        };
    });

    // Format the items
    const formattedItems = Object.entries(items).map(([itemId, itemData]) => {
        const totalQty = itemData.customizations.reduce((sum, customization) => {
            return sum + (customization.qty || 0);
        }, 0);

        const itemDetails = itemDetailsMap[itemId] || {
            name: 'Unknown Item',
            description: 'No description available.',
            price: "Unknown",
        };

        return {
            id: itemId,
            name: itemDetails.name,
            description: itemDetails.description,
            price: itemDetails.price,
            qty: totalQty
        };
    });

    return formattedItems;
}

const getFormatedOrderCart = async (items) => {
    if (!items) {
        return [];
    }
    const itemIds = Object.keys(items);
    const menuItemsResult = await pool.query('SELECT id, name, description, price, ingredients, serving_size, dietary_info, taste, calories FROM menu_items WHERE id = ANY($1)', [itemIds]);

    const itemDetailsMap = {};
    menuItemsResult.rows.forEach(item => {
        itemDetailsMap[item.id] = {
            name: item.name,
            description: item.description,
            price: item.price,
            ingredients: item.ingredients,
            serving_size: item.serving_size,
            dietary_info: item.dietary_info,
            taste: item.taste,
            calories: item.calories
        };
    });

    const formattedItems = Object.entries(items).map(([itemId, itemData]) => {
        const totalQty = itemData.customizations.reduce((sum, customization) => {
            return sum + (customization.qty || 0);
        }, 0);

        const itemDetails = itemDetailsMap[itemId] || {
            name: 'Unknown Item',
            description: 'No description available.',
            price: "Unknown",
            ingredients: [],
            serving_size: "",
            dietary_info: [],
            taste: [],
            calories: ""
        };

        return {
            id: itemId,
            name: itemDetails.name,
            description: itemDetails.description,
            price: itemDetails.price,
            ingredients: itemDetails.ingredients,
            serving_size: itemDetails.serving_size,
            dietary_info: itemDetails.dietary_info,
            taste: itemDetails.taste,
            calories: itemDetails.calories,
            qty: totalQty
        };
    });

    return formattedItems;
}

const getCurrentOrderItemIds = async (restaurantId, tableId) => {
    try {
        const orderResult = await pool.query('SELECT json_data FROM orders WHERE restaurant_id = $1 AND table_id = $2', [restaurantId, tableId]);
        if (orderResult.rows.length === 0) return [];
        const items = orderResult.rows[0].json_data.items || {};
        return Object.keys(items);
    } catch (error) {
        console.error('Error getting current order item IDs:', error);
        return [];
    }
};

const getCurrentOrders = async (restaurantId, tableId, isShort = false) => {
    try {
        const items = await tableHasOrder(restaurantId, tableId);
        if (isShort) {
            return await getFormatedShortOrderCart(items);
        }
        return await getFormatedOrderCart(items);
    } catch (error) {
        console.error('Error getting current orders:', error);
        return [];
    }
};

const completeOrder = async (
    restaurantId,
    tableId,
    total,
    paymentMethod = '',
    razorpayOrderId = '',
    razorpayPaymentId = '',
    orderId = null
) => {
    const client = await pool.connect();
    let order = null;

    try {
        await client.query('BEGIN');

        // 1) fetch & lock - if orderId is provided, use it; otherwise find by table
        let orderRes, tempRes;
        
        if (orderId) {
            // Complete specific order by ID
            [orderRes, tempRes] = await Promise.all([
                client.query(
                    `SELECT * FROM orders
                        WHERE restaurant_id = $1 AND id = $2
                        FOR UPDATE`,
                    [restaurantId, orderId]
                ),
                client.query(
                    `SELECT * FROM tempOrders
                        WHERE restaurant_id = $1 AND table_id = $2
                        FOR UPDATE`,
                    [restaurantId, tableId]
                ),
            ]);
        } else {
            // Original behavior - find by table
            [orderRes, tempRes] = await Promise.all([
                client.query(
                    `SELECT * FROM orders
                        WHERE restaurant_id = $1 AND table_id = $2
                        FOR UPDATE`,
                    [restaurantId, tableId]
                ),
                client.query(
                    `SELECT * FROM tempOrders
                        WHERE restaurant_id = $1 AND table_id = $2
                        FOR UPDATE`,
                    [restaurantId, tableId]
                ),
            ]);
        }

        if (!orderRes.rows.length && !tempRes.rows.length) {
            await client.query('ROLLBACK');
            return false;
        }

        // 2) merge items
        const confirmed = orderRes.rows[0] || { json_data: { items: {} } };
        const temp      = tempRes.rows[0]   || { json_data: { items: {} } };
        const items     = mergerOrders(
            confirmed.json_data.items,
            temp.json_data.items
        );

        // 3) build your "completed" order object
        order = orderRes.rows[0] || tempRes.rows[0];
        order.json_data.items = items;

        // 4) insert + cleanup in one transaction
        const insertSql = `
            INSERT INTO completed_orders (
                id, restaurant_id, table_id, created_at,
                completed_at, json_data, total, claps,
                payment_method, razorpay_order_id, razorpay_payment_id,
                invoice_number, butler_discount_applied, butler_discount_value,
                petpooja_bill_data, butler_discount_id, bill_data
            ) VALUES (
                $1, $2, $3, $4,
                CURRENT_TIMESTAMP, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16
            )
        `;
        await client.query(insertSql, [
            order.id,
            order.restaurant_id,
            order.table_id,
            order.created_at,
            order.json_data,
            total,
            0, // claps
            paymentMethod,
            razorpayOrderId,
            razorpayPaymentId,
            order.invoice_number || null,
            order.butler_discount_applied || false,
            order.butler_discount_value || 0,
            order.petpooja_bill_data || null,
            order.butler_discount_id || null,
            order.bill_data || null,
        ]);

        // archive & cleanup
        await Promise.all([
            client.query(`DELETE FROM orders WHERE id = $1`, [order.id]),
            client.query(`DELETE FROM tempOrders WHERE id = $1`, [tempRes.rows[0]?.id]),
        ]);

        await client.query('COMMIT');
        return true;
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Error in completeOrder:', err);
        return false;
    } finally {
        client.release();
    }
};

module.exports = {
    mergerOrders,
    tableHasOrder,
    getTableOrder,
    getTableGuestCount,
    getTableOrderDetails,
    getFormatedShortOrderCart,
    getFormatedOrderCart,
    getCurrentOrderItemIds,
    getCurrentOrders,
    completeOrder
}; 
