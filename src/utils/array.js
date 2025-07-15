function parsePgArray(str) {
    if (!str || str === '{}') return [];
    const inner = str.slice(1, -1);
    return inner.split(',').map(item => item.trim().replace(/^"(.*)"$/, '$1'));
}

module.exports = {
    parsePgArray
}; 