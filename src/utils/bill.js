const {pool} = require('../config/db');

const getOrderSubTotal = (order) => {
    if (!order || Object.keys(order).length === 0) {
        return 0;
    }

    let subtotal = 0;

    // Calculate subtotal
    for (const itemId in order) {
        if (order.hasOwnProperty(itemId)) {
            const itemDetails = order[itemId];
            itemDetails.customizations.forEach((customization) => {
                subtotal += customization.price * customization.qty;
            });
            
        }
    }

    return subtotal;
};

const roundOffAmount = (original, roundingType) => {
    let value;
  switch (roundingType) {
    case 'round-up':
      value = Math.ceil(original);
      break;
    case 'round-down':
      value = Math.floor(original);
      break;
    case 'round-up-down':
      value = Math.round(original);
      break;
    default:
        return { value: original, roundedOff: 0 }
  }
  // how much it was shifted, always positive
  const roundedOff = Math.abs(value - original);
  return { value, roundedOff };
}

const parsePetPoojaBillData = (data = {},roundingType) => {
    let discountedTotal = parseFloat(parseFloat(data.combinedTotal ?? data.discountedTotal ?? data.total ?? 0).toFixed(2));
    let discountRoundOff = 0;
    if (roundingType && roundingType != 'default') {
        const discountRounding = roundOffAmount(discountedTotal,roundingType);
        discountedTotal = discountRounding.value;
        discountRoundOff = discountRounding.roundedOff;
    }

    return {
        subtotal: parseFloat(parseFloat(data.combinedCorePrice ?? data.subtotal ?? 0).toFixed(2)),
        serviceCharge: parseFloat(parseFloat(data.combinedServiceCharge ?? data.serviceCharge ?? 0).toFixed(2)),
        tax: parseFloat(parseFloat(data.combinedTax ?? data.tax ?? 0).toFixed(2)),
        discount: parseFloat(parseFloat(data.combinedDiscount ?? 0).toFixed(2)),
        totalRoundOff: parseFloat(parseFloat(data.combinedRoundOff ?? 0).toFixed(2)),
        discountRoundOff: discountRoundOff,
        total: parseFloat(parseFloat(data.originalCombinedTotal ?? data.total ?? 0).toFixed(2)),
        discountedTotal: discountedTotal,
        butlerDiscount: parseFloat(parseFloat(data.butlerDiscounts ?? data.butlerDiscount ?? 0).toFixed(2)),
        serviceChargeWaivedOff: parseFloat(data.serviceChargeWaivedOff ?? 0),
    }
};

const calculateOrderValues = (order,restaurantData) => {
    if (!order || Object.keys(order).length === 0) {
        return {
            subtotal: 0.00,
            serviceCharge: 0.00,
            tax: 0.00,
            total: 0.00,
            totalRoundOff: 0.00,
            discountRoundOff: 0.00,
            butlerDiscount: 0.00,
            discountedTotal: 0.00,
            discount: 0.00
        };
    }

    let subtotal = 0;
    let alcholeSubTotal = 0;
    let nonAlcholeSubTotal = 0;

    // Calculate subtotal
    for (const itemId in order) {
        if (order.hasOwnProperty(itemId)) {
            const itemDetails = order[itemId];
            itemDetails.customizations.forEach((customization) => {
              subtotal += customization.price * customization.qty;
            }); 
        }
    }

    let cgst = 0;
    let sgst = 0;
    let tax = 0;
    let serviceCharge = 0, alcholeServiceCharge = 0, nonAlcholeServiceCharge = 0;
    let total = 0, butlerDiscount = 0, discountedTotal = 0,totalRoundOff = 0, discountRoundOff = 0;
    
    if (restaurantData.isservicecharge) {
        serviceCharge = subtotal *  (restaurantData.servicechargepercent/100);
        total = subtotal + serviceCharge;
    }
    else {
        total = subtotal;
    }

    if (!restaurantData.isgstincluded) {
        cgst = total * 0.025;
        sgst = total * 0.025;
        tax = total * 0.05;
        total = total + tax;
    }

    if (restaurantData.isbutlerdiscount) {
        //Apply discount
        discountedTotal = total; //Adjust discount here
        butlerDiscount = 0; //Add discount amount here
    }
    else {
        discountedTotal = total;
    }

    if (restaurantData.rounding_type && restaurantData.rounding_type != 'default') {
        const discountRounding = roundOffAmount(discountedTotal,restaurantData.rounding_type);
        discountedTotal = discountRounding.value;
        discountRoundOff = discountRounding.roundedOff;
        const totalRounding = roundOffAmount(total,restaurantData.rounding_type);
        total = totalRounding.value;
        totalRoundOff = totalRounding.roundedOff;
    }

    return {
        subtotal: parseFloat(Number(subtotal).toFixed(2)),
        serviceCharge: parseFloat(Number(serviceCharge).toFixed(2)),
        tax: parseFloat(Number(tax).toFixed(2)),
        total: parseFloat(Number(total).toFixed(2)),
        totalRoundOff: totalRoundOff,
        discountRoundOff: discountRoundOff,
        butlerDiscount: parseFloat(Number(butlerDiscount).toFixed(2)),
        discountedTotal: parseFloat(Number(discountedTotal).toFixed(2)),
        discount: 0.00
    };
};

const getCurrentBillData = async (restaurant,orders) => {
    if (restaurant.ispetpoojaenabled) {
        const petPoojaBill = orders.petpooja_bill_data;

        if (!petPoojaBill || Object.keys(petPoojaBill).length === 0) {
            const billData = calculateOrderValues(orders.json_data.items,restaurant);
            return {
                status: 'success',
                billSource: 'butler',
                billData
            };

        }
        const billData = parsePetPoojaBillData(petPoojaBill,restaurant.rounding_type);
        return {
            status: 'success',
            billSource: 'petpooja',
            billData
        };


    }

    else {
        const billData = calculateOrderValues(orders.json_data.items,restaurant);
        return {
            status: 'success',
            billSource: 'butler',
            billData
        };
    }
}

module.exports = {
    getOrderSubTotal,
    roundOffAmount,
    getCurrentBillData,
    calculateOrderValues
}; 