const sortVariation = (variation) => {
    if (!variation || typeof variation !== 'object') return '';
    const variationString = Object.values(variation).join(', ');
    return variationString.split(',').map(v => v.trim()).sort().join(', ');
  };
   
  const sortAddons = (addons) => {
    if (!addons || typeof addons !== 'object') return '';
    // Get sorted keys of the addons object
    const addonKeys = Object.keys(addons).sort();
    const sortedAddons = addonKeys.map(key => {
      const addonArray = addons[key];
      // Normalize each addon object by sorting its keys and then joining the key-value pairs
      const sortedAddonArray = addonArray
        .map(addon =>
          Object.keys(addon)
            .sort()
            .map(k => `${k}:${addon[k]}`)
            .join(',')
        )
        .sort() // Ensure the array order is normalized
        .join('|');
      return `${key}:${sortedAddonArray}`;
    });
    return sortedAddons.join(', ');
  };
   
  module.exports = { sortVariation,sortAddons };