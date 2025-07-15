const {pool} = require("../config/db");
const {parsePgArray} = require('./array');
const {getOrderSubTotal} = require("./bill");
const {getMissingCourseNLowQty} = require("./recommendation");
const { tableHasOrder, getTableGuestCount } = require('./order');
const { sendNotificationToRestaurant } = require('./sendNotifications');
const { insertNotification } = require('./notificationsUtil');
const redisClient = require("../config/redis");

const getCourseItemsInCart = (currentCart,offers, menuItems, mealType) => {
    let applicableOffer = offers.filter((offer) => offer.course === mealType);
    if (!currentCart || Object.keys(currentCart).length === 0 || !applicableOffer || applicableOffer.length === 0) {
        return { count: 0, items: [] };
    }

    applicableOffer = applicableOffer[0];

    let count = 0;
    let items = [];
    const itemIds = [];

    Object.keys(currentCart).forEach((itemId) => {
        const item = menuItems[itemId];
        const isOfferApplicable = applicableOffer.items.some((item) => item.id === itemId);
        if (!isOfferApplicable) {
            return;
        }
        if (item && item.meal_type.includes(mealType)) {
            if (!itemIds.includes(itemId)) {
                itemIds.push(itemId);
            }
            currentCart[itemId].customizations.forEach((customization) => {
                count += customization.qty;
                price = item.price;
                let id = itemId;
                if (customization.variation && Object.keys(customization.variation).length > 0) {
                    id = `${id}||${customization.variation.id}`;
                    price = customization.variation.price;
                }

                const existingItem = items.find((i) => i.id === id);
                if (existingItem) {
                    existingItem.qty += customization.qty;
                } else {
                    items.push({ id, qty: customization.qty, price });
                }
            });
        }
    });

    return { count, items, itemIds };
};

async function getUniqueDiscountCode(length = 6) {
    const { nanoid } = await import('nanoid');
    return nanoid(length);
}

const generateVolumnOffer = async (restaurantId,tableId,orderItems) => {
    const volumnOfferKey = `volumn_offer_${tableId}`
    let volumnOfferCreated = true;
    try {
        const volumnOfferCreatedRaw = await redisClient.get(volumnOfferKey);
        if (!volumnOfferCreatedRaw) {
            volumnOfferCreated = false;
        }
        else {
            volumnOfferCreated = JSON.parse(volumnOfferCreatedRaw);
        }

        if (!volumnOfferCreated) {
            const offerSettingsQuery = `
                SELECT *
                FROM offer_settings
                where restaurant_id = $1 AND offer_type = 'volumn_offer'
            `;
            const offerSettingsRes = await pool.query(offerSettingsQuery, [restaurantId]);

            if (offerSettingsRes.rows.length === 0) {
                return false;
            }

            const offerSettings = offerSettingsRes.rows[0];
            const offerPercentage = offerSettings.max_offer_percentage; // discount percent applied on (orderSubTotal + candidate total)
            const p = offerPercentage / 100; // 0.15
            const upsellRequired = offerSettings.upsell_required;

            const subTotal = getOrderSubTotal(orderItems);
            if (!subTotal) {
                return false;
            }
            const upsellAmount = Math.round(subTotal * p);

            const minOrderValue = upsellAmount + subTotal;

            let discountName = `Volumn offer for table ${tableId}`;
            let discountMethod = "PERCENTAGE";
            let discountScope = "BILL";
        
            // Calculate current IST time
            const now = new Date();
            const istOffsetMinutes = 5.5 * 60; // IST is UTC+5:30, i.e. 330 minutes
            const serverOffset = now.getTimezoneOffset(); // in minutes
            const nowIST = new Date(now.getTime() + (istOffsetMinutes + serverOffset) * 60000);
        
            // Format date as YYYY-MM-DD
            const startDate = nowIST.toISOString().split('T')[0];
            const endDate = new Date(nowIST.getTime() + 24 * 60 * 60 * 1000).toISOString().split('T')[0];
        
            // Format time as HH:MM:SS (using the time portion from ISO string)
            const startTime = nowIST.toTimeString().split(' ')[0];
            const endTime = new Date(nowIST.getTime() + 5 * 60 * 60 * 1000).toTimeString().split(' ')[0];
        
            const code = await getUniqueDiscountCode();
            // Build the INSERT query
            const discountQuery = `
            INSERT INTO discounts (
                restaurant_id,
                table_number,
                name,
                discount_scope,
                discount_method,
                discount_value,
                max_discount,
                applicable_targets,
                start_date,
                end_date,
                start_time,
                end_time,
                usage_limit,
                used_count,
                is_active,
                code,
                min_order_value
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
            RETURNING id
            `;
        
            const discountValues = [
                restaurantId,
                tableId,
                discountName,                     
                discountScope,                    
                discountMethod,                  
                offerPercentage,                     
                null,                    
                null,
                startDate,                        // Current date in IST
                endDate,                          // 24 hours later in IST
                startTime,                        // Current time in IST (HH:MM:SS)
                endTime,                          // 5 hours later (HH:MM:SS)
                1,                                // usage_limit
                0,                                // used_count
                true,                             // is_active
                code,
                minOrderValue
            ];
        
            try {
                const discountResult = await pool.query(discountQuery, discountValues);
                const discountId = discountResult.rows[0].id;
                console.log("Discount inserted with id:", discountId);
                await redisClient.set(volumnOfferKey, JSON.stringify(true));
                return {
                    status: true,
                    amountNeeded: minOrderValue - subTotal,
                    discount: `${offerPercentage} %`
                }
            } catch (err) {
                console.error("Error inserting discount:", err, discountValues);
                return false;
            }
            
        }
        else {
            return false;
        }
    }
    catch (error) {
        console.error(error);
        return false;
    }
}

const disableOffers = async (
    restaurantId,
    tableId,
    orderId,
    { offerFullyAvailed, offerPartiallyAvailed },
    offerId = null
  ) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
  
      // only proceed if something was availed
      if (offerFullyAvailed || offerPartiallyAvailed) {
        // 1) update orders
        const orderField = offerFullyAvailed
          ? 'offer_availed'
          : 'offer_partially_availed';
  
        await client.query(
          `
            UPDATE orders
               SET ${orderField} = TRUE,
                   is_payment_thirdparty = FALSE
             WHERE id = $1
          `,
          [orderId]
        );
  
        // 2) deactivate other offers
        const dynamicParams = [restaurantId, tableId];
        let dynamicSql = `
          UPDATE dynamic_offers
             SET active = FALSE
           WHERE restaurant_id = $1
             AND table_id      = $2
             AND active        = TRUE
        `;
  
        // if we have an offerId, exclude it
        if (offerPartiallyAvailed && offerId) {
          dynamicSql += ' AND id <> $3';
          dynamicParams.push(offerId);
        }
  
        await client.query(dynamicSql, dynamicParams);
  
        // 3) deactivate the corresponding discount
        const discountName = `Fixed discount on payment through Butler pay for table ${tableId}`;
        const discountMethod = 'PERCENTAGE';
        const discountValue = 12;
  
        await client.query(
          `
            UPDATE discounts
               SET is_active = FALSE
             WHERE restaurant_id  = $1
               AND table_number   = $2
               AND discount_method = $3
               AND discount_value  = $4
               AND name            = $5
          `,
          [
            restaurantId,
            tableId,
            discountMethod,
            discountValue,
            discountName
          ]
        );
      }
  
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  };

const disableExistingDiscount = async (restaurantId,tableId) => {
    await pool.query(
        `UPDATE discounts SET is_active = false WHERE restaurant_id = $1 AND table_number = $2 AND is_active = true`,
        [restaurantId, tableId]
    );
}

const getAvailedOffers = async (order,orderId,offers,selectedOffer,restaurantId,tableId) => {
    try {
        const menuItemsQuery = `
            SELECT id, name, price, meal_type
            FROM menu_items
            WHERE restaurantid = $1
        `;
        const menuItemsResult = await pool.query(menuItemsQuery, [restaurantId]);
        const menuItems = {};
        menuItemsResult.rows.forEach((item) => {
            menuItems[item.id] = {
                ...item,
                meal_type: parsePgArray(item.meal_type),
            };
        });

        const selectedOfferObj = offers.find((offer) => offer.id === selectedOffer);
        if (!selectedOfferObj) {
            return false;
        }

        const { course } = selectedOfferObj;
        const { count, items, itemIds } = getCourseItemsInCart(order,offers, menuItems, course);

        if (count === 0) {
            return false;
        }

        const offerItems = selectedOfferObj.items;
        const offerItemsCount = offerItems.reduce((acc, item) => acc + item.qty, 0);

        const offerFullyAvailed = count >= offerItemsCount;
        const offerPartiallyAvailed = count > 0 && count < offerItemsCount;

        if (offerFullyAvailed || offerPartiallyAvailed) {
            await disableOffers(
                restaurantId,
                tableId,
                orderId,
                { offerFullyAvailed, offerPartiallyAvailed },
                selectedOffer
            );
        }

        return {
            offerFullyAvailed,
            offerPartiallyAvailed
        };
    } catch (error) {
        console.error('Error in getAvailedOffers:', error);
        throw error;
    }
};

const disableAvailableOffers = async (order,offers,restaurantId) => {
    try {
        const menuItemsQuery = `
            SELECT id, name, price, meal_type
            FROM menu_items
            WHERE restaurantid = $1
        `;
        const menuItemsResult = await pool.query(menuItemsQuery, [restaurantId]);
        const menuItems = {};
        menuItemsResult.rows.forEach((item) => {
            menuItems[item.id] = {
                ...item,
                meal_type: parsePgArray(item.meal_type),
            };
        });

        for (const offer of offers) {
            const { course } = offer;
            const { count, items, itemIds } = getCourseItemsInCart(order,offers, menuItems, course);

            if (count === 0) {
                continue;
            }

            const offerItems = offer.items;
            const offerItemsCount = offerItems.reduce((acc, item) => acc + item.qty, 0);

            const offerFullyAvailed = count >= offerItemsCount;
            const offerPartiallyAvailed = count > 0 && count < offerItemsCount;

            if (offerFullyAvailed || offerPartiallyAvailed) {
                await pool.query(
                    `UPDATE dynamic_offers SET active = false WHERE id = $1`,
                    [offer.id]
                );
            }
        }
    } catch (error) {
        console.error('Error in disableAvailableOffers:', error);
        throw error;
    }
};

function roundUpToEndingIn9(price) {
    if (price <= 0) return 0;
    const lastDigit = price % 10;
    if (lastDigit === 9) return price;
    return price + (9 - lastDigit);
}

const roundToNearest10 = (num) => Math.round(num / 10) * 10;

const generateThirdPartyDynamicOffers = async (courseList,restaurantId, tableId) => {
    try {
        const offerSettingsQuery = `
            SELECT *
            FROM offer_settings
            where restaurant_id = $1 AND offer_type = 'third_party_offer'
        `;
        const offerSettingsRes = await pool.query(offerSettingsQuery, [restaurantId]);

        if (offerSettingsRes.rows.length === 0) {
            return false;
        }

        const offerSettings = offerSettingsRes.rows[0];
        const offerPercentage = offerSettings.max_offer_percentage; // discount percent applied on (orderSubTotal + candidate total)
        const p = offerPercentage / 100; // 0.15
        const upsellRequired = offerSettings.upsell_required;

        const menuItemsQuery = `
            SELECT id, name, price, meal_type
            FROM menu_items
            WHERE restaurantid = $1
        `;
        const menuItemsResult = await pool.query(menuItemsQuery, [restaurantId]);
        const menuItems = {};
        menuItemsResult.rows.forEach((item) => {
            menuItems[item.id] = {
                ...item,
                meal_type: parsePgArray(item.meal_type),
            };
        });

        const offers = [];

        for (const course of courseList) {
            const courseItems = Object.values(menuItems).filter((item) =>
                item.meal_type.includes(course)
            );

            if (courseItems.length === 0) {
                continue;
            }

            const courseItemsWithPrice = courseItems.map((item) => ({
                id: item.id,
                name: item.name,
                price: item.price,
            }));

            const sortedItems = courseItemsWithPrice.sort((a, b) => a.price - b.price);

            const minPrice = sortedItems[0].price;
            const maxPrice = sortedItems[sortedItems.length - 1].price;

            const priceRanges = [];
            let currentMin = minPrice;

            while (currentMin <= maxPrice) {
                const currentMax = roundUpToEndingIn9(currentMin + 100);
                priceRanges.push({
                    min: currentMin,
                    max: currentMax,
                    items: sortedItems.filter(
                        (item) => item.price >= currentMin && item.price <= currentMax
                    ),
                });
                currentMin = currentMax + 1;
            }

            for (const range of priceRanges) {
                if (range.items.length === 0) {
                    continue;
                }

                const avgPrice = Math.floor(
                    range.items.reduce((sum, item) => sum + item.price, 0) /
                    range.items.length
                );

                const minQty = 2;
                const maxQty = 4;

                for (let qty = minQty; qty <= maxQty; qty++) {
                    const totalPrice = avgPrice * qty;
                    const discount = Math.floor(totalPrice * p);
                    const discountedPrice = totalPrice - discount;

                    const offer = {
                        course,
                        items: range.items.map((item) => ({
                            ...item,
                            qty,
                        })),
                        priceRange: {
                            min: range.min,
                            max: range.max,
                        },
                        qty,
                        avgPrice,
                        totalPrice,
                        discount,
                        discountedPrice,
                    };

                    offers.push(offer);
                }
            }
        }

        // Sort offers by discount amount (highest first)
        offers.sort((a, b) => b.discount - a.discount);

        // Take top 3 offers
        const topOffers = offers.slice(0, 3);

        // Insert offers into database
        for (const offer of topOffers) {
            const query = `
                INSERT INTO dynamic_offers (
                    restaurant_id,
                    table_id,
                    course,
                    items,
                    price_range,
                    qty,
                    avg_price,
                    total_price,
                    discount,
                    discounted_price,
                    active,
                    offer_type
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
            `;

            const values = [
                restaurantId,
                tableId,
                offer.course,
                JSON.stringify(offer.items),
                JSON.stringify(offer.priceRange),
                offer.qty,
                offer.avgPrice,
                offer.totalPrice,
                offer.discount,
                offer.discountedPrice,
                true,
                'third_party'
            ];

            await pool.query(query, values);
        }

        return true;
    } catch (error) {
        console.error('Error generating third party dynamic offers:', error);
        return false;
    }
};

const generateDynamicOffers = async (courseList,restaurantId, tableId, isAutoGeneration = false, order = null) => {
    try {
        const offerSettingsQuery = `
            SELECT *
            FROM offer_settings
            where restaurant_id = $1 AND offer_type = 'butler_offer'
        `;
        const offerSettingsRes = await pool.query(offerSettingsQuery, [restaurantId]);

        if (offerSettingsRes.rows.length === 0) {
            return false;
        }

        const offerSettings = offerSettingsRes.rows[0];
        const offerPercentage = offerSettings.max_offer_percentage; // discount percent applied on (orderSubTotal + candidate total)
        const p = offerPercentage / 100; // 0.15
        const upsellRequired = offerSettings.upsell_required;

        const menuItemsQuery = `
            SELECT id, name, price, meal_type
            FROM menu_items
            WHERE restaurantid = $1
        `;
        const menuItemsResult = await pool.query(menuItemsQuery, [restaurantId]);
        const menuItems = {};
        menuItemsResult.rows.forEach((item) => {
            menuItems[item.id] = {
                ...item,
                meal_type: parsePgArray(item.meal_type),
            };
        });

        const offers = [];

        for (const course of courseList) {
            const courseItems = Object.values(menuItems).filter((item) =>
                item.meal_type.includes(course)
            );

            if (courseItems.length === 0) {
                continue;
            }

            const courseItemsWithPrice = courseItems.map((item) => ({
                id: item.id,
                name: item.name,
                price: item.price,
            }));

            const sortedItems = courseItemsWithPrice.sort((a, b) => a.price - b.price);

            const minPrice = sortedItems[0].price;
            const maxPrice = sortedItems[sortedItems.length - 1].price;

            const priceRanges = [];
            let currentMin = minPrice;

            while (currentMin <= maxPrice) {
                const currentMax = roundUpToEndingIn9(currentMin + 100);
                priceRanges.push({
                    min: currentMin,
                    max: currentMax,
                    items: sortedItems.filter(
                        (item) => item.price >= currentMin && item.price <= currentMax
                    ),
                });
                currentMin = currentMax + 1;
            }

            for (const range of priceRanges) {
                if (range.items.length === 0) {
                    continue;
                }

                const avgPrice = Math.floor(
                    range.items.reduce((sum, item) => sum + item.price, 0) /
                    range.items.length
                );

                const minQty = 2;
                const maxQty = 4;

                for (let qty = minQty; qty <= maxQty; qty++) {
                    const totalPrice = avgPrice * qty;
                    const discount = Math.floor(totalPrice * p);
                    const discountedPrice = totalPrice - discount;

                    const offer = {
                        course,
                        items: range.items.map((item) => ({
                            ...item,
                            qty,
                        })),
                        priceRange: {
                            min: range.min,
                            max: range.max,
                        },
                        qty,
                        avgPrice,
                        totalPrice,
                        discount,
                        discountedPrice,
                    };

                    offers.push(offer);
                }
            }
        }

        // Sort offers by discount amount (highest first)
        offers.sort((a, b) => b.discount - a.discount);

        // Take top 3 offers
        const topOffers = offers.slice(0, 3);

        // Insert offers into database
        for (const offer of topOffers) {
            const query = `
                INSERT INTO dynamic_offers (
                    restaurant_id,
                    table_id,
                    course,
                    items,
                    price_range,
                    qty,
                    avg_price,
                    total_price,
                    discount,
                    discounted_price,
                    active,
                    offer_type
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
            `;

            const values = [
                restaurantId,
                tableId,
                offer.course,
                JSON.stringify(offer.items),
                JSON.stringify(offer.priceRange),
                offer.qty,
                offer.avgPrice,
                offer.totalPrice,
                offer.discount,
                offer.discountedPrice,
                true,
                'butler'
            ];

            await pool.query(query, values);
        }

        // Create a discount in the discounts table
        let discountName = `Fixed discount on payment through Butler pay for table ${tableId}`;
        let discountMethod = "PERCENTAGE";
        let discountScope = "BILL";
        let discountValue = 12;

        // Calculate current IST time
        const now = new Date();
        const istOffsetMinutes = 5.5 * 60; // IST is UTC+5:30, i.e. 330 minutes
        const serverOffset = now.getTimezoneOffset(); // in minutes
        const nowIST = new Date(now.getTime() + (istOffsetMinutes + serverOffset) * 60000);

        // Format date as YYYY-MM-DD
        const startDate = nowIST.toISOString().split('T')[0];
        const endDate = new Date(nowIST.getTime() + 24 * 60 * 60 * 1000).toISOString().split('T')[0];

        // Format time as HH:MM:SS (using the time portion from ISO string)
        const startTime = nowIST.toTimeString().split(' ')[0];
        const endTime = new Date(nowIST.getTime() + 5 * 60 * 60 * 1000).toTimeString().split(' ')[0];

        const code = await getUniqueDiscountCode();
        // Build the INSERT query
        const discountQuery = `
        INSERT INTO discounts (
            restaurant_id,
            table_number,
            name,
            discount_scope,
            discount_method,
            discount_value,
            max_discount,
            applicable_targets,
            start_date,
            end_date,
            start_time,
            end_time,
            usage_limit,
            used_count,
            is_active,
            code
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
        RETURNING id
        `;

        const discountValues = [
            restaurantId,
            tableId,
            discountName,                     
            discountScope,                    
            discountMethod,                  
            discountValue,                     
            null,                    
            null,
            startDate,                        // Current date in IST
            endDate,                          // 24 hours later in IST
            startTime,                        // Current time in IST (HH:MM:SS)
            endTime,                          // 5 hours later (HH:MM:SS)
            1,                                // usage_limit
            0,                                // used_count
            true,                             // is_active
            code
        ];

        try {
            const discountResult = await pool.query(discountQuery, discountValues);
            const discountId = discountResult.rows[0].id;
            console.log("Discount inserted with id:", discountId);
        } catch (err) {
            console.error("Error inserting discount:", err, discountValues);
        }

        if (isAutoGeneration) {
            const guestCount = await getTableGuestCount(restaurantId, tableId);
            const missingCourseNLowQty = await getMissingCourseNLowQty(order, guestCount);
            const notificationData = {
                tableId: String(tableId),
                missingItems: JSON.stringify(missingCourseNLowQty)
            }
            await sendNotificationToRestaurant(
                '',
                '',
                notificationData,
                restaurantId,
                'butler',
                true,
            );
        }

        return true;
    } catch (error) {
        console.error('Error generating dynamic offers:', error);
        return false;
    }
};

const isOfferItems = (offers, items) => {
    if (!offers || !items) {
        return false;
    }

    const offerItems = offers.map((offer) => offer.items).flat();
    const offerItemIds = offerItems.map((item) => item.id);
    const itemIds = Object.keys(items);

    return itemIds.some((itemId) => offerItemIds.includes(itemId));
};

module.exports = {
    generateDynamicOffers,
    generateThirdPartyDynamicOffers,
    getAvailedOffers,
    disableAvailableOffers,
    generateVolumnOffer,
    isOfferItems
}; 