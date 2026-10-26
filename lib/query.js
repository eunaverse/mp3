const { ApiError } = require('./api');

function parseJsonObject(value, name) {
    if (value === undefined) return undefined;

    let parsed;
    try {
        parsed = JSON.parse(value);
    } catch (err) {
        throw new ApiError(400, `The ${name} parameter must contain valid JSON.`, null);
    }

    if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
        throw new ApiError(400, `The ${name} parameter must be a JSON object.`, null);
    }
    return parsed;
}

function parseNonnegativeInteger(value, name) {
    if (value === undefined) return undefined;
    if (!/^\d+$/.test(value)) {
        throw new ApiError(400, `The ${name} parameter must be a nonnegative integer.`, null);
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) {
        throw new ApiError(400, `The ${name} parameter must be a nonnegative integer.`, null);
    }
    return parsed;
}

function parseCount(value) {
    if (value === undefined || value === 'false') return false;
    if (value === 'true') return true;
    throw new ApiError(400, 'The count parameter must be true or false.', null);
}

function parseSort(value) {
    const sort = parseJsonObject(value, 'sort');
    if (sort && Object.values(sort).some((direction) => direction !== 1 && direction !== -1)) {
        throw new ApiError(400, 'Each sort direction must be 1 or -1.', null);
    }
    return sort;
}

function parseSelect(value) {
    const select = parseJsonObject(value, 'select');
    if (select && Object.values(select).some((included) => included !== 0 && included !== 1)) {
        throw new ApiError(400, 'Each select value must be 1 or 0.', null);
    }
    return select;
}

function parseCollectionQuery(query, defaultLimit) {
    return {
        where: parseJsonObject(query.where, 'where') || {},
        sort: parseSort(query.sort),
        select: parseSelect(query.select),
        skip: parseNonnegativeInteger(query.skip, 'skip') || 0,
        limit: query.limit === undefined ? defaultLimit : parseNonnegativeInteger(query.limit, 'limit'),
        count: parseCount(query.count)
    };
}

module.exports = { parseCollectionQuery, parseSelect };
