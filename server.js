const mongoose = require('mongoose');
require('dotenv').config();
const app = require('./app');

const port = process.env.PORT || 3000;

async function start() {
    if (!process.env.MONGODB_URI) {
        throw new Error('MONGODB_URI is required.');
    }
    await mongoose.connect(process.env.MONGODB_URI);
    app.listen(port, () => console.log(`Server running on port ${port}`));
}

start().catch((err) => {
    console.error('Unable to start the server:', err.message);
    process.exitCode = 1;
});
