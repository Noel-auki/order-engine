function sortVariation(variation) {
    if (!variation || Object.keys(variation).length === 0) {
        return '';
    }
    
    // Sort the keys of the variation object
    const sortedKeys = Object.keys(variation).sort();
    
    // Create a new object with sorted keys
    const sortedVariation = sortedKeys.reduce((acc, key) => {
        acc[key] = variation[key];
        return acc;
    }, {});
    
    // Return stringified sorted object
    return JSON.stringify(sortedVariation);
}

module.exports = { sortVariation }; 