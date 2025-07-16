const { pool } = require('../config/db');

/**
 * Cancel an order and move it to canceledOrders table.
 * @route POST /pos/cancel-order
 * @body { orderId: string }
 */
const cancelOrder = async (req, res) => {
  const { orderId } = req.body;

  if (!orderId) {
    return res.status(400).json({ message: 'Missing orderId in request body' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Fetch the order
    const orderRes = await client.query('SELECT * FROM orders WHERE id = $1', [orderId]);
    if (orderRes.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Order not found' });
    }

    const orderData = orderRes.rows[0];
    const { restaurant_id, table_id } = orderData;

    // 2. Add canceled timestamp
    orderData.canceled_at = new Date();

    // 3. Move to canceledOrders
    const insertFields = Object.keys(orderData);
    const insertValues = Object.values(orderData);
    const placeholders = insertFields.map((_, i) => `$${i + 1}`).join(',');

    await client.query(
      `INSERT INTO canceledOrders (${insertFields.join(',')}) VALUES (${placeholders})`,
      insertValues
    );

    // 4. Delete from orders
    await client.query('DELETE FROM orders WHERE id = $1', [orderId]);

    // 5. Clean up related data
    await Promise.all([
      client.query('DELETE FROM notifications WHERE order_id = $1', [orderId]),
      client.query('DELETE FROM table_otps WHERE restaurant_id = $1 AND table_id = $2', [restaurant_id, table_id]),
      client.query('DELETE FROM discounts WHERE restaurant_id = $1 AND table_number = $2 AND is_active = true', [restaurant_id, table_id]),
      client.query('DELETE FROM dynamic_offers WHERE order_id = $1', [orderId]),
      client.query(
        `UPDATE captains
         SET assigned_tables = (
           SELECT jsonb_agg(value)
           FROM jsonb_array_elements_text(assigned_tables) AS arr(value)
           WHERE value != $1
         )
         WHERE restaurant_id = $2 AND assigned_tables @> to_jsonb($1::text)`,
        [table_id, restaurant_id]
      )
    ]);

    await client.query('COMMIT');
    return res.status(200).json({ message: 'Order cancelled and related data removed.' });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Cancel Order Error:', error);
    return res.status(500).json({ message: 'Internal server error' });
  } finally {
    client.release();
  }
};

  
  
module.exports = {
  cancelOrder
};
