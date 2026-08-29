'use strict';




const dealsMaxUsedFundsPipeline = (
    filters = {},
    botIds = null,
    since = null,
    maxDealsPerBot = 1
) => {

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

        {
            $addFields: {
                lastFilledOrder: { $arrayElemAt: ["$filledOrders", -1] }
            }
        },

        ...(since ? [{
            $match: {
                "lastFilledOrder.dateFilled": { $gte: new Date(since) }
            }
        }] : []),

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

        { $sort: { botId: 1, lastSum: -1 } },

        {
            $group: {
                _id: "$botId",
                botName: { $first: "$botName" },
                maxLastSum: { $max: "$lastSum" },
                deals: {
                    $push: {
                        dealId: "$dealId",
                        lastSum: "$lastSum",
                        lastOrderNo: "$lastOrderNo",
                        lastOrder: "$lastOrder"
                    }
                }
            }
        },

        {
            $lookup: {
                from: "bots",
                localField: "_id",
                foreignField: "botId",
                as: "bot"
            }
        },

        {
            $addFields: {
                botConfig: { $arrayElemAt: ["$bot.config", 0] }
            }
        },

        {
            $project: {
                botId: "$_id",
                botName: 1,
                maxLastSum: 1,
                botConfig: 1,
                deals: { $slice: ["$deals", maxDealsPerBot] },
                _id: 0
            }
        },

        { $sort: { botName: 1 } }
    ];
};


module.exports = {

	dealsMaxUsedFundsPipeline,
}
