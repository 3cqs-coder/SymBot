'use strict';

const fs = require('fs');
const path = require('path');

const pathRoot = path.resolve(__dirname, ...Array(3).fill('..'));


const dealsMaxUsedFundsPipeline = (filters = {}, botIds = null, since = null) => {

    const matchStage = {};

    for (const [key, value] of Object.entries(filters)) {
        if (value === null) matchStage[key] = { $in: [null] };
        else if (Array.isArray(value)) matchStage[key] = { $in: value };
        else matchStage[key] = value;
    }

    if (botIds) {
        matchStage.botId = Array.isArray(botIds) ? { $in: botIds } : botIds;
    }

    return [
        { $match: matchStage },

        // Keep only filled orders
        {
            $addFields: {
                filledOrders: {
                    $filter: {
                        input: "$orders",
                        as: "o",
                        cond: { $eq: ["$$o.filled", 1] }
                    }
                }
            }
        },

        // Get last filled order per deal
        {
            $addFields: {
                lastFilledOrder: { $arrayElemAt: ["$filledOrders", -1] }
            }
        },

        // Optional filtering by since date
        ...(since
            ? [
                {
                    $match: {
                        "lastFilledOrder.dateFilled": { $gte: new Date(since) }
                    }
                }
            ]
            : []),

        // Project last order info
        {
            $project: {
                botId: 1,
                botName: 1,
                dealId: 1,
                lastSum: { $toDouble: "$lastFilledOrder.sum" },
                lastOrderNo: "$lastFilledOrder.orderNo",
                lastOrder: "$lastFilledOrder"
            }
        },

        // Sort descending by lastSum so the highest is first per bot
        { $sort: { botId: 1, lastSum: -1 } },

        // Group by botId, taking the first (highest) lastSum
        {
            $group: {
                _id: "$botId",
                botName: { $first: "$botName" },
                maxLastSum: { $first: "$lastSum" },
                maxOrder: { $first: "$lastOrder" },
                dealId: { $first: "$dealId" },
                orderNo: { $first: "$lastOrderNo" }
            }
        },

        // Rename _id to botId
        {
            $project: {
                botId: "$_id",
                botName: 1,
                maxLastSum: 1,
                maxOrder: 1,
                dealId: 1,
                orderNo: 1,
                _id: 0
            }
        }
    ];
};



module.exports = {

	dealsMaxUsedFundsPipeline,
}
