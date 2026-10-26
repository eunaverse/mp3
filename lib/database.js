const mongoose = require('mongoose');

async function inTransaction(work) {
    const session = await mongoose.startSession();
    let result;
    try {
        await session.withTransaction(async () => {
            result = await work(session);
        });
        return result;
    } finally {
        await session.endSession();
    }
}

module.exports = { inTransaction };
