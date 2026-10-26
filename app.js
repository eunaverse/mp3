const express = require('express');
const { errorHandler, send } = require('./lib/api');

const app = express();

app.use(function allowCrossDomain(req, res, next) {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'X-Requested-With, X-HTTP-Method-Override, Content-Type, Accept');
    res.header('Access-Control-Allow-Methods', 'POST, GET, PUT, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') return res.status(204).end();
    return next();
});

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

require('./routes')(app, express.Router());

app.use('/api', function apiNotFound(req, res) {
    return send(res, 404, 'API endpoint not found.', null);
});
app.use(errorHandler);

module.exports = app;
