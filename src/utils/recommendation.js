const {pool} = require('../config/db');
const {parsePgArray} = require('./array');

const getMissingCourseNLowQty = async (order, guestCount) => {
    try {
        if (!order || Object.keys(order).length === 0) {
            return {
                missingCourses: [],
                lowQtyCourses: []
            };
        }

        const courseList = ['Appetizers', 'Main Courses', 'Beverages', 'Desserts'];
        const courseQtyMap = {};
        const missingCourses = [];
        const lowQtyCourses = [];

        // Initialize course quantities
        courseList.forEach(course => {
            courseQtyMap[course] = 0;
        });

        // Calculate quantities for each course
        for (const itemId in order) {
            if (order.hasOwnProperty(itemId)) {
                const itemDetails = order[itemId];
                itemDetails.customizations.forEach((customization) => {
                    const qty = customization.qty;
                    const mealType = itemDetails.meal_type;
                    if (mealType) {
                        mealType.forEach(type => {
                            if (courseQtyMap.hasOwnProperty(type)) {
                                courseQtyMap[type] += qty;
                            }
                        });
                    }
                });
            }
        }

        // Check for missing and low quantity courses
        courseList.forEach(course => {
            if (courseQtyMap[course] === 0) {
                missingCourses.push(course);
            } else if (courseQtyMap[course] < guestCount) {
                lowQtyCourses.push({
                    course,
                    current: courseQtyMap[course],
                    required: guestCount
                });
            }
        });

        return {
            missingCourses,
            lowQtyCourses
        };
    } catch (error) {
        console.error('Error in getMissingCourseNLowQty:', error);
        throw error;
    }
};

module.exports = {
    getMissingCourseNLowQty
}; 