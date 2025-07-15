const redisClient = require("../config/redis"); // Ensure proper Redis client is imported
const {pool} = require("../config/db");
const { v4: uuidv4 } = require('uuid');
const { performance } = require('perf_hooks');

/**
 * Adds `value` to the Redis-list at key `sessions:${restaurantId}:${tableId}`
 * only if it isn't already in the list.
 *
 * @param {string} restaurantId
 * @param {string} tableId
 * @param {string} value        // e.g. a session ID or anything you like
 * @returns {Promise<string[]>} // the up-to-date array of values
 */
async function addToTableSessions(restaurantId, tableId, value) {
  const key = `sessions:${restaurantId}:${tableId}`;

  // Fetch the entire list (will be [] if key doesn't exist)
  const current = await redisClient.lRange(key, 0, -1);

  // If not already present, push to tail
  if (!current.includes(value)) {
    await redisClient.rPush(key, value);
    current.push(value);
  }

  return current;
}

/**
 * Retrieves all sessions for a given restaurant/table,
 * returning a JS array with duplicates removed.
 *
 * @param {string} restaurantId
 * @param {string} tableId
 * @returns {Promise<string[]>}
 */
async function getTableSessions (restaurantId, tableId) {
  const key = `sessions:${restaurantId}:${tableId}`;

  // fetch entire list (or [] if key doesn't exist)
  const all = await redisClient.lRange(key, 0, -1);

  // remove duplicates while preserving insertion order
  const unique = Array.from(new Set(all));

  return unique;
}

/**
 * Update a field for all sessions in a given restaurant and table.
 *
 * @param {string} restaurantId - The restaurant ID.
 * @param {string} tableId - The table ID.
 * @param {string} field - The field to update in the session.
 * @param {*} value - The new value (or value to push if field is an array).
 */
const updateAllRedisTableSessions = async (restaurantId, tableId, field, value) => {
  try {
    // 1. Get all session IDs for this restaurant/table
    const sessionIds = await getTableSessions(restaurantId, tableId);

    if (sessionIds.length === 0) {
      console.log(`No sessions found for ${restaurantId}/${tableId}.`);
      return;
    }

    // 2. For each session ID, fetch, update, and save back the JSON
    for (const sessionId of sessionIds) {
      const key = sessionId;

      try {
        const raw = await redisClient.get(key);
        if (!raw) {
          console.log(`  • Key ${key} missing, skipping`);
          continue;
        }

        const session = JSON.parse(raw);

        // Update or push into array
        if (Array.isArray(session[field])) {
          if (Array.isArray(value)) {
            session[field] = value;
          } else if (!session[field].includes(value)) {
            session[field].push(value);
          }
        } else {
          session[field] = value;
        }

        await redisClient.set(key, JSON.stringify(session));
        console.log(`  ✓ Updated ${key}`);
      } catch (innerErr) {
        console.error(`  ⚠️ Error on ${key}:`, innerErr);
      }
    }

    console.log(`Finished updating ${sessionIds.length} sessions for ${restaurantId}/${tableId}.`);
  } catch (err) {
    console.error(`Failed to update sessions for ${restaurantId}/${tableId}:`, err);
    throw err;
  }
};

/**
 * Update session data in Redis
 * @param {string} sessionKey - The Redis session key (e.g., session:restaurantId:tableId:userId)
 * @param {string} field - The field to update in the session data (e.g., name, phoneNumber, context)
 * @param {any} value - The value to update the field with (if array, append to array)
 * @returns {Promise<void>} - A promise that resolves when the data is updated
 */
const updateRedisSession = async (sessionKey, field, value) => {
  try {
    // Get the current session data from Redis
    const sessionData = await redisClient.get(sessionKey);

    if (!sessionData) {
      console.log(`No sessions found for sessionKey ${sessionKey}.`);
      return;
    }

    // Parse the session data (as it's stored as JSON string in Redis)
    const session = JSON.parse(sessionData);

    // Check if the field to be updated is an array
    if (Array.isArray(session[field])) {
      if (Array.isArray(value)) {
        session[field] = value;
      }
      else {
        session[field].push(value);
      }
      
    } else {
      // Otherwise, update the field with the new value
      session[field] = value;
    }

    // Store the updated session back to Redis
    await redisClient.set(sessionKey, JSON.stringify(session));

    console.log(`Session with key ${field} updated successfully`);
  } catch (error) {
    console.error(`Error updating session with key ${sessionKey}:`, error);
    throw error;
  }
};

/**
 * Retrieve multiple fields from a JSON object stored in Redis
 * @param {string} sessionKey - The Redis key to retrieve the JSON object
 * @param {string[]} fieldKeys - The fields to retrieve from the JSON object
 * @returns {Promise<Object|null>} - An object containing the requested field values
 */
const getRedisFieldsValue = async (sessionKey, fieldKeys) => {
  if (!sessionKey || !Array.isArray(fieldKeys) || fieldKeys.length === 0) {
      return null;
  }
  
  try {
      // Retrieve the value from Redis
      const value = await redisClient.get(sessionKey);

      // If no value is found, return null
      if (value === null) {
          return null;
      }

      // Attempt to parse the value as JSON
      let parsedValue;
      try {
          parsedValue = JSON.parse(value);
      } catch (error) {
          throw new Error(`Value for session key "${sessionKey}" is not in valid JSON format`);
      }

      // Extract requested fields
      const result = {};
      fieldKeys.forEach(fieldKey => {
          if (parsedValue.hasOwnProperty(fieldKey)) {
              result[fieldKey] = parsedValue[fieldKey];
          }
      });

      // Return the result, or null if no fields were found
      return Object.keys(result).length > 0 ? result : null;

  } catch (error) {
      console.error(`Error retrieving fields ${JSON.stringify(fieldKeys)} from session key "${sessionKey}" in Redis:`, error);
      throw error;
  }
};

/**
 * Retrieve a specific field from a JSON object stored in Redis
 * @param {string} sessionKey - The Redis key to retrieve the JSON object
 * @param {string} fieldKey - The field to retrieve from the JSON object
 * @returns {Promise<any>} - The value of the specific field in the JSON object
 */
const getRedisFieldValue = async (sessionKey, fieldKey) => {
    if (!sessionKey) {
      return null;
    }
    try {
      // Retrieve the value from Redis
      const value = await redisClient.get(sessionKey);
  
      // If no value is found, return null
      if (value === null) {
        return null;
      }
  
      // Attempt to parse the value as JSON
      let parsedValue;
      try {
        parsedValue = JSON.parse(value);
      } catch (error) {
        throw new Error(`Value for session key "${sessionKey}" is not in valid JSON format`);
      }
  
      // Check if the field exists in the parsed object
      if (parsedValue.hasOwnProperty(fieldKey)) {
        return parsedValue[fieldKey]; // Return the value of the fieldKey
      } else {
        return null; // Field does not exist
      }
    } catch (error) {
      console.error(`Error retrieving field "${fieldKey}" from session key "${sessionKey}" in Redis:`, error);
      throw error; // Rethrow the error to handle it in the calling function
    }
  };

/**
 * Fetch all sessions for a given restaurant and table,
 * returning an object keyed by the full Redis key with parsed JSON values.
 *
 * @param {string} restaurantId
 * @param {string} tableId
 * @returns {Promise<Object>}  // { "session:...:...:sessionId": { ... } } or { message: ... }
 */
const getAllSessionsForRestaurantTable = async (restaurantId, tableId) => {
  try {
    // 1. Grab the deduped list of session IDs from our 'sessions:' list
    const sessionIds = await getTableSessions(restaurantId, tableId);

    if (sessionIds.length === 0) {
      return { message: "No active sessions found for the specified restaurant and table." };
    }

    // 2. For each session ID, fetch and parse the JSON
    const sessions = {};
    for (const sessionId of sessionIds) {
      const key = sessionId;
      const raw = await redisClient.get(key);

      if (raw) {
        try {
          sessions[key] = JSON.parse(raw);
        } catch (err) {
          console.error(`Failed to parse JSON for ${key}:`, err);
          sessions[key] = { error: "Invalid JSON data" };
        }
      } else {
        console.warn(`Missing data for session ${key}`);
      }
    }

    return sessions;
  } catch (err) {
    console.error(`Failed to fetch sessions for ${restaurantId}/${tableId}:`, err);
    throw err;
  }
};

/**
 * Fetch all sessions for a given restaurant,
 * returning an object keyed by the full Redis key with parsed JSON values.
 *
 * @param {string} restaurantId
 * @returns {Promise<Object>}  // { "session:...:...:sessionId": { ... } } or { message: ... }
 */
const getAllSessionsForRestaurant = async (restaurantId) => {
  try {
    // 1. Get all keys matching the pattern
    const pattern = `session:${restaurantId}:*`;
    const keys = await redisClient.keys(pattern);

    if (keys.length === 0) {
      return { message: "No active sessions found for the specified restaurant." };
    }

    // 2. For each key, fetch and parse the JSON
    const sessions = {};
    for (const key of keys) {
      const raw = await redisClient.get(key);

      if (raw) {
        try {
          sessions[key] = JSON.parse(raw);
        } catch (err) {
          console.error(`Failed to parse JSON for ${key}:`, err);
          sessions[key] = { error: "Invalid JSON data" };
        }
      } else {
        console.warn(`Missing data for session ${key}`);
      }
    }

    return sessions;
  } catch (err) {
    console.error(`Failed to fetch sessions for restaurant ${restaurantId}:`, err);
    throw err;
  }
};

/**
 * Handle closing a session by removing it from the sessions list and deleting its data.
 *
 * @param {string} restaurantId
 * @param {string} tableId
 * @returns {Promise<void>}
 */
const handleCloseSession = async (restaurantId, tableId) => {
  try {
    // 1. Get the list key
    const listKey = `sessions:${restaurantId}:${tableId}`;

    // 2. Get all session IDs for this restaurant/table
    const sessionIds = await redisClient.lRange(listKey, 0, -1);

    // 3. For each session ID:
    for (const sessionId of sessionIds) {
      // a) Delete the session data
      await redisClient.del(sessionId);
      console.log(`Deleted session data for ${sessionId}`);
    }

    // 4. Delete the list itself
    await redisClient.del(listKey);
    console.log(`Deleted sessions list for ${restaurantId}/${tableId}`);

  } catch (err) {
    console.error(`Failed to close sessions for ${restaurantId}/${tableId}:`, err);
    throw err;
  }
};

/**
 * Migrate all sessions from one table to another within the same restaurant.
 * This involves:
 * 1. Getting all session IDs for the old table
 * 2. Creating new session IDs for the new table
 * 3. Copying the session data to the new IDs
 * 4. Updating the sessions list for the new table
 * 5. Cleaning up the old sessions
 *
 * @param {string} restaurantId
 * @param {string} oldTableId
 * @param {string} newTableId
 * @returns {Promise<void>}
 */
const migrateTableSessions = async (restaurantId, oldTableId, newTableId) => {
  try {
    // 1. Get all session IDs for the old table
    const oldSessions = await getAllSessionsForRestaurantTable(restaurantId, oldTableId);

    // Skip if no sessions found
    if (oldSessions.message) {
      console.log(oldSessions.message);
      return;
    }

    // 2. For each old session:
    for (const [oldKey, sessionData] of Object.entries(oldSessions)) {
      // a) Generate a new session ID
      const newSessionId = uuidv4();

      // b) Create the new session key
      const newKey = `session:${restaurantId}:${newTableId}:${newSessionId}`;

      // c) Store the session data under the new key
      await redisClient.set(newKey, JSON.stringify(sessionData));

      // d) Add the new session ID to the new table's sessions list
      await addToTableSessions(restaurantId, newTableId, newKey);

      console.log(`Migrated session from ${oldKey} to ${newKey}`);
    }

    // 3. Clean up the old sessions
    await handleCloseSession(restaurantId, oldTableId);

    console.log(`Successfully migrated all sessions from table ${oldTableId} to ${newTableId}`);
  } catch (err) {
    console.error('Failed to migrate sessions:', err);
    throw err;
  }
};

const getTableSessionKey = async (restaurantId,tableId) => {
  try {
    const sessionIds = await getTableSessions(restaurantId, tableId);
    if (sessionIds.length === 0) {
      return null;
    }
    return sessionIds[0];
  }
  catch (error) {
    console.error('Error getting table session key:', error);
    throw error;
  }
}

const deleteRedisSession = async (restID, tableNo) => {
  try {
    const sessionKey = `sessions:${restID}:${tableNo}`;
    const sessionIds = await redisClient.lRange(sessionKey, 0, -1);
    if (sessionIds.length > 0) {
      for (const sessionId of sessionIds) {
        await redisClient.del(sessionId);
      }
      await redisClient.del(sessionKey);
    }
  } catch (error) {
    console.error('Error deleting Redis session:', error);
    throw error;
  }
};

module.exports = {
  addToTableSessions,
  getTableSessions,
  updateAllRedisTableSessions,
  updateRedisSession,
  getRedisFieldsValue,
  getRedisFieldValue,
  getAllSessionsForRestaurantTable,
  getAllSessionsForRestaurant,
  handleCloseSession,
  migrateTableSessions,
  getTableSessionKey,
  deleteRedisSession
}; 