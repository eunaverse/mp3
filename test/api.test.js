const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const request = require('supertest');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const app = require('../app');
const User = require('../models/user');
const Task = require('../models/task');

let mongo;

function postUser(overrides = {}) {
    return request(app).post('/api/users').send({
        name: 'Ada Lovelace',
        email: `ada-${new mongoose.Types.ObjectId()}@example.com`,
        ...overrides
    });
}

function postTask(overrides = {}) {
    return request(app).post('/api/tasks').send({
        name: 'Write tests',
        deadline: '2026-11-01T12:00:00.000Z',
        ...overrides
    });
}

test.before(async () => {
    mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(mongo.getUri());
    await Promise.all([User.syncIndexes(), Task.syncIndexes()]);
});

test.after(async () => {
    await mongoose.disconnect();
    await mongo.stop();
});

test.beforeEach(async () => {
    await Promise.all([User.deleteMany({}), Task.deleteMany({})]);
});

test('API root uses the required response envelope', async () => {
    const response = await request(app).get('/api/').expect(200);
    assert.equal(typeof response.body.message, 'string');
    assert.equal(response.body.data, null);
    const missing = await request(app).get('/api/unknown').expect(404);
    assert.deepEqual(Object.keys(missing.body).sort(), ['data', 'message']);
});

test('POST /users creates defaults, ignores client dateCreated, and returns 201', async () => {
    const response = await postUser({ dateCreated: '2000-01-01T00:00:00.000Z' }).expect(201);
    assert.equal(response.body.message, 'User created successfully.');
    assert.equal(response.body.data.name, 'Ada Lovelace');
    assert.deepEqual(response.body.data.pendingTasks, []);
    assert.notEqual(response.body.data.dateCreated, '2000-01-01T00:00:00.000Z');
    assert.ok(response.body.data._id);
});

test('POST /users rejects missing fields, wrong types, duplicate email, and malformed task ids', async () => {
    await request(app).post('/api/users').send(null).expect(400);
    await request(app).post('/api/users').send([]).expect(400);
    await request(app).post('/api/users').send({ email: 'missing@example.com' }).expect(400);
    await request(app).post('/api/users').send({ name: 7, email: 'wrong@example.com' }).expect(400);
    await request(app).post('/api/users').send({ name: 'A', email: 'a@example.com', pendingTasks: 'no' }).expect(400);
    await request(app).post('/api/users').send({ name: 'A', email: 'a@example.com', pendingTasks: ['bad-id'] }).expect(400);
    const duplicateTaskId = new mongoose.Types.ObjectId().toString();
    await request(app).post('/api/users').send({
        name: 'A', email: 'duplicate-task@example.com', pendingTasks: [duplicateTaskId, duplicateTaskId]
    }).expect(400);
    await request(app).post('/api/users').send({
        name: 'A', email: 'missing-task@example.com', pendingTasks: [new mongoose.Types.ObjectId()]
    }).expect(404);
    const completed = (await postTask({ completed: true }).expect(201)).body.data;
    await request(app).post('/api/users').send({
        name: 'A', email: 'completed-task@example.com', pendingTasks: [completed._id]
    }).expect(400);
    await postUser({ email: 'same@example.com' }).expect(201);
    const duplicate = await postUser({ email: 'same@example.com' }).expect(400);
    assert.deepEqual(Object.keys(duplicate.body).sort(), ['data', 'message']);
});

test('malformed JSON returns a technology-independent 400 response', async () => {
    const response = await request(app)
        .post('/api/users')
        .set('Content-Type', 'application/json')
        .send('{"name":')
        .expect(400);
    assert.deepEqual(Object.keys(response.body).sort(), ['data', 'message']);
    assert.doesNotMatch(response.body.message, /syntax|express|mongo|mongoose/i);
});

test('unexpected database failures return a safe response envelope', async () => {
    const originalFind = User.find;
    const originalConsoleError = console.error;
    User.find = function failFind() {
        throw new Error('Mongoose internal connection details');
    };
    console.error = function suppressExpectedTestError() {};

    try {
        const response = await request(app).get('/api/users').expect(500);
        assert.deepEqual(response.body, {
            message: 'An unexpected server error occurred.',
            data: null
        });
        assert.doesNotMatch(JSON.stringify(response.body), /mongoose|connection/i);
    } finally {
        User.find = originalFind;
        console.error = originalConsoleError;
    }
});

test('POST /tasks applies defaults and validates values and assignees', async () => {
    const basic = await postTask({ dateCreated: '2000-01-01T00:00:00.000Z' }).expect(201);
    assert.equal(basic.body.data.description, '');
    assert.equal(basic.body.data.completed, false);
    assert.equal(basic.body.data.assignedUser, '');
    assert.equal(basic.body.data.assignedUserName, 'unassigned');
    assert.notEqual(basic.body.data.dateCreated, '2000-01-01T00:00:00.000Z');

    await request(app).post('/api/tasks').send({ deadline: '2026-11-01' }).expect(400);
    await postTask({ deadline: 12345 }).expect(400);
    await postTask({ deadline: 'not-a-date' }).expect(400);
    await postTask({ description: 42 }).expect(400);
    await postTask({ completed: 'false' }).expect(400);
    await postTask({ assignedUser: 42 }).expect(400);
    await postTask({ assignedUser: 'bad-id' }).expect(400);
    await postTask({ assignedUserName: 42 }).expect(400);
    await postTask({ assignedUserName: 'Nobody' }).expect(400);
    await postTask({ assignedUser: new mongoose.Types.ObjectId().toString() }).expect(404);

    const user = await postUser({ name: 'Grace', email: 'grace@example.com' }).expect(201);
    const mismatch = await postTask({
        assignedUser: user.body.data._id,
        assignedUserName: 'Wrong Name'
    }).expect(400);
    assert.match(mismatch.body.message, /does not match/i);

    const assigned = await postTask({ assignedUser: user.body.data._id }).expect(201);
    assert.equal(assigned.body.data.assignedUserName, 'Grace');
    const refreshed = await User.findById(user.body.data._id).lean();
    assert.deepEqual(refreshed.pendingTasks, [assigned.body.data._id]);
});

test('single-resource GET supports select and returns 404 for malformed or missing ids', async () => {
    const user = await postUser({ email: 'select@example.com' }).expect(201);
    const selected = await request(app)
        .get(`/api/users/${user.body.data._id}`)
        .query({ select: JSON.stringify({ name: 1, _id: 0 }), where: 'ignored' })
        .expect(200);
    assert.deepEqual(selected.body.data, { name: 'Ada Lovelace' });

    await request(app).get('/api/users/not-an-id').expect(404);
    await request(app).get(`/api/users/${new mongoose.Types.ObjectId()}`).expect(404);
    await request(app).get(`/api/users/${user.body.data._id}`).query({ select: '{bad' }).expect(400);
    await request(app).get(`/api/users/${user.body.data._id}`)
        .query({ select: JSON.stringify({ name: 2 }) }).expect(400);

    const task = await postTask().expect(201);
    const taskSelected = await request(app)
        .get(`/api/tasks/${task.body.data._id}`)
        .query({ select: JSON.stringify({ name: 1, completed: 1, _id: 0 }) })
        .expect(200);
    assert.deepEqual(taskSelected.body.data, { name: 'Write tests', completed: false });
    await request(app).get('/api/tasks/not-an-id').expect(404);
    await request(app).get(`/api/tasks/${new mongoose.Types.ObjectId()}`).expect(404);
    await request(app).get(`/api/tasks/${task.body.data._id}`).query({ select: '{bad' }).expect(400);
    await request(app).get(`/api/tasks/${task.body.data._id}`)
        .query({ select: JSON.stringify({ name: -1 }) }).expect(400);
});

test('collection GET combines where, sort, select, skip, limit, and count', async () => {
    const inserted = await Task.insertMany([
        { name: 'C', deadline: new Date('2026-11-03'), completed: true },
        { name: 'A', deadline: new Date('2026-11-01'), completed: true },
        { name: 'B', deadline: new Date('2026-11-02'), completed: true },
        { name: 'D', deadline: new Date('2026-11-04'), completed: false }
    ]);

    const list = await request(app).get('/api/tasks').query({
        where: JSON.stringify({ completed: true }),
        sort: JSON.stringify({ name: 1 }),
        select: JSON.stringify({ name: 1, _id: 0 }),
        skip: '1',
        limit: '1'
    }).expect(200);
    assert.deepEqual(list.body.data, [{ name: 'B' }]);

    const count = await request(app).get('/api/tasks').query({
        where: JSON.stringify({ completed: true }),
        count: 'true',
        limit: '1'
    }).expect(200);
    assert.equal(count.body.data, 3);

    const byIds = await request(app).get('/api/tasks').query({
        where: JSON.stringify({ _id: { $in: [inserted[0]._id, inserted[3]._id] } }),
        sort: JSON.stringify({ name: 1 })
    }).expect(200);
    assert.deepEqual(byIds.body.data.map((task) => task.name), ['C', 'D']);

    const empty = await request(app).get('/api/users').query({
        where: JSON.stringify({ email: 'nobody@example.com' })
    }).expect(200);
    assert.deepEqual(empty.body.data, []);

    await request(app).get('/api/tasks').query({ where: '{bad' }).expect(400);
    await request(app).get('/api/tasks').query({ sort: '[]' }).expect(400);
    await request(app).get('/api/tasks').query({ skip: '-1' }).expect(400);
    await request(app).get('/api/tasks').query({ limit: 'one' }).expect(400);
    await request(app).get('/api/tasks').query({ limit: '9007199254740992' }).expect(400);
    await request(app).get('/api/tasks').query({ count: 'yes' }).expect(400);
    await request(app).get('/api/tasks').query({ sort: JSON.stringify({ name: 2 }) }).expect(400);
    await request(app).get('/api/tasks').query({ select: JSON.stringify({ name: 'yes' }) }).expect(400);
});

test('limit=0 returns no resources rather than triggering Mongoose unlimited semantics', async () => {
    await Promise.all([postUser().expect(201), postTask().expect(201)]);

    const tasks = await request(app).get('/api/tasks').query({ limit: '0' }).expect(200);
    const users = await request(app).get('/api/users').query({ limit: '0' }).expect(200);
    assert.deepEqual(tasks.body.data, []);
    assert.deepEqual(users.body.data, []);
});

test('GET /users supports the complete collection-query feature set', async () => {
    await User.insertMany([
        { name: 'Charlie', email: 'c@example.com' },
        { name: 'Alice', email: 'a@example.com' },
        { name: 'Bob', email: 'b@example.com' }
    ]);
    const list = await request(app).get('/api/users').query({
        where: JSON.stringify({ email: { $in: ['a@example.com', 'b@example.com', 'c@example.com'] } }),
        sort: JSON.stringify({ name: 1 }),
        select: JSON.stringify({ name: 1, _id: 0 }),
        skip: '1',
        limit: '1'
    }).expect(200);
    assert.deepEqual(list.body.data, [{ name: 'Bob' }]);

    const count = await request(app).get('/api/users').query({ count: 'true' }).expect(200);
    assert.equal(count.body.data, 3);
});

test('PUT /tasks handles completion, reopening, moving, unassigning, and preserves dateCreated', async () => {
    const first = (await postUser({ name: 'First', email: 'first@example.com' }).expect(201)).body.data;
    const second = (await postUser({ name: 'Second', email: 'second@example.com' }).expect(201)).body.data;
    const task = (await postTask({ assignedUser: first._id }).expect(201)).body.data;

    const complete = await request(app).put(`/api/tasks/${task._id}`).send({
        name: 'Completed work',
        deadline: '2026-12-01',
        completed: true,
        assignedUser: first._id,
        assignedUserName: 'First',
        dateCreated: '2000-01-01'
    }).expect(200);
    assert.equal(complete.body.data.assignedUser, first._id);
    assert.equal(complete.body.data.dateCreated, task.dateCreated);
    assert.deepEqual((await User.findById(first._id).lean()).pendingTasks, []);

    await request(app).put(`/api/tasks/${task._id}`).send({
        name: 'Reopened work', deadline: '2026-12-02', assignedUser: second._id
    }).expect(200);
    assert.deepEqual((await User.findById(first._id).lean()).pendingTasks, []);
    assert.deepEqual((await User.findById(second._id).lean()).pendingTasks, [task._id]);

    const unassigned = await request(app).put(`/api/tasks/${task._id}`).send({
        name: 'Unassigned work', deadline: '2026-12-03'
    }).expect(200);
    assert.equal(unassigned.body.data.assignedUser, '');
    assert.equal(unassigned.body.data.assignedUserName, 'unassigned');
    assert.deepEqual((await User.findById(second._id).lean()).pendingTasks, []);
});

test('PUT /users replaces pendingTasks, moves tasks, unassigns removals, and propagates a renamed user', async () => {
    const first = (await postUser({ name: 'First', email: 'first@example.com' }).expect(201)).body.data;
    const second = (await postUser({ name: 'Second', email: 'second@example.com' }).expect(201)).body.data;
    const removed = (await postTask({ assignedUser: first._id }).expect(201)).body.data;
    const moved = (await postTask({ assignedUser: second._id }).expect(201)).body.data;
    const completed = (await postTask({ assignedUser: first._id, completed: true }).expect(201)).body.data;

    const updated = await request(app).put(`/api/users/${first._id}`).send({
        name: 'Renamed First',
        email: 'renamed@example.com',
        pendingTasks: [moved._id],
        dateCreated: '2000-01-01'
    }).expect(200);
    assert.deepEqual(updated.body.data.pendingTasks, [moved._id]);
    assert.equal(updated.body.data.dateCreated, first.dateCreated);

    const removedTask = await Task.findById(removed._id).lean();
    assert.equal(removedTask.assignedUser, '');
    assert.equal(removedTask.assignedUserName, 'unassigned');
    const movedTask = await Task.findById(moved._id).lean();
    assert.equal(movedTask.assignedUser, first._id);
    assert.equal(movedTask.assignedUserName, 'Renamed First');
    assert.deepEqual((await User.findById(second._id).lean()).pendingTasks, []);
    assert.equal((await Task.findById(completed._id).lean()).assignedUserName, 'Renamed First');
});

test('POST /users with pendingTasks moves tasks away from their previous owner', async () => {
    const oldOwner = (await postUser({ name: 'Old', email: 'old@example.com' }).expect(201)).body.data;
    const task = (await postTask({ assignedUser: oldOwner._id }).expect(201)).body.data;
    const newOwner = await postUser({
        name: 'New', email: 'new@example.com', pendingTasks: [task._id]
    }).expect(201);

    assert.deepEqual((await User.findById(oldOwner._id).lean()).pendingTasks, []);
    assert.deepEqual(newOwner.body.data.pendingTasks, [task._id]);
    const moved = await Task.findById(task._id).lean();
    assert.equal(moved.assignedUser, newOwner.body.data._id);
    assert.equal(moved.assignedUserName, 'New');
});

test('PUT replacement defaults omitted optional fields and an omitted pendingTasks list', async () => {
    const user = (await postUser({ email: 'replace@example.com' }).expect(201)).body.data;
    const task = (await postTask({
        description: 'will disappear', completed: true, assignedUser: user._id
    }).expect(201)).body.data;

    const replacedTask = await request(app).put(`/api/tasks/${task._id}`).send({
        name: 'Replacement', deadline: '2027-01-01'
    }).expect(200);
    assert.equal(replacedTask.body.data.description, '');
    assert.equal(replacedTask.body.data.completed, false);
    assert.equal(replacedTask.body.data.assignedUser, '');
    assert.equal(replacedTask.body.data.assignedUserName, 'unassigned');

    const pending = (await postTask({ assignedUser: user._id }).expect(201)).body.data;
    const replacedUser = await request(app).put(`/api/users/${user._id}`).send({
        name: 'Replacement User', email: 'replacement@example.com'
    }).expect(200);
    assert.deepEqual(replacedUser.body.data.pendingTasks, []);
    assert.equal((await Task.findById(pending._id).lean()).assignedUser, '');
});

test('PUT validates replacement bodies, duplicate emails, and referenced resources', async () => {
    const first = (await postUser({ email: 'first@example.com' }).expect(201)).body.data;
    const second = (await postUser({ email: 'second@example.com' }).expect(201)).body.data;
    const task = (await postTask().expect(201)).body.data;

    await request(app).put(`/api/users/${first._id}`).send({ email: 'changed@example.com' }).expect(400);
    await request(app).put(`/api/users/${first._id}`).send({
        name: 'Duplicate', email: second.email
    }).expect(400);
    await request(app).put(`/api/users/${first._id}`).send({
        name: 'Missing task', email: 'missing-task@example.com',
        pendingTasks: [new mongoose.Types.ObjectId().toString()]
    }).expect(404);

    await request(app).put(`/api/tasks/${task._id}`).send({ deadline: '2027-01-01' }).expect(400);
    await request(app).put(`/api/tasks/${task._id}`).send({
        name: 'Missing user', deadline: '2027-01-01',
        assignedUser: new mongoose.Types.ObjectId().toString()
    }).expect(404);

    const unchangedUser = await User.findById(first._id).lean();
    const unchangedTask = await Task.findById(task._id).lean();
    assert.equal(unchangedUser.email, 'first@example.com');
    assert.equal(unchangedTask.name, 'Write tests');
});

test('completed assigned tasks retain their owner without entering pendingTasks', async () => {
    const user = (await postUser({ email: 'completed-owner@example.com' }).expect(201)).body.data;
    const task = await postTask({ assignedUser: user._id, completed: true }).expect(201);

    assert.equal(task.body.data.assignedUser, user._id);
    assert.equal(task.body.data.assignedUserName, user.name);
    assert.deepEqual((await User.findById(user._id).lean()).pendingTasks, []);
});

test('a failed task update leaves the task and both users unchanged', async () => {
    const first = (await postUser({ name: 'First', email: 'first@example.com' }).expect(201)).body.data;
    const second = (await postUser({ name: 'Second', email: 'second@example.com' }).expect(201)).body.data;
    const task = (await postTask({ assignedUser: first._id }).expect(201)).body.data;

    await request(app).put(`/api/tasks/${task._id}`).send({
        name: 'Should not persist',
        deadline: '2027-01-01',
        assignedUser: second._id,
        assignedUserName: 'Not Second'
    }).expect(400);

    const unchanged = await Task.findById(task._id).lean();
    assert.equal(unchanged.name, 'Write tests');
    assert.equal(unchanged.assignedUser, first._id);
    assert.deepEqual((await User.findById(first._id).lean()).pendingTasks, [task._id]);
    assert.deepEqual((await User.findById(second._id).lean()).pendingTasks, []);

    await request(app).put('/api/tasks/not-an-id').send({}).expect(404);
    await request(app).put(`/api/tasks/${new mongoose.Types.ObjectId()}`).send({}).expect(404);
});

test('GET /tasks defaults to 100 results while GET /users is unlimited', async () => {
    const tasks = Array.from({ length: 105 }, (_, index) => ({
        name: `Task ${index}`,
        deadline: new Date('2027-01-01')
    }));
    const users = Array.from({ length: 105 }, (_, index) => ({
        name: `User ${index}`,
        email: `user-${index}@example.com`
    }));
    await Promise.all([Task.insertMany(tasks), User.insertMany(users)]);

    const taskResponse = await request(app).get('/api/tasks').expect(200);
    const userResponse = await request(app).get('/api/users').expect(200);
    assert.equal(taskResponse.body.data.length, 100);
    assert.equal(userResponse.body.data.length, 105);
});

test('failed user updates are atomic and status precedence starts with the URL id', async () => {
    const user = (await postUser({ email: 'atomic@example.com' }).expect(201)).body.data;
    const completed = (await postTask({ completed: true }).expect(201)).body.data;

    await request(app).put('/api/users/not-an-id').send({}).expect(404);
    await request(app).put(`/api/users/${new mongoose.Types.ObjectId()}`).send({}).expect(404);
    await request(app).put(`/api/users/${user._id}`).send({
        name: 'Changed', email: 'changed@example.com', pendingTasks: [completed._id]
    }).expect(400);

    const unchanged = await User.findById(user._id).lean();
    assert.equal(unchanged.name, 'Ada Lovelace');
    assert.equal(unchanged.email, 'atomic@example.com');
    assert.deepEqual(unchanged.pendingTasks, []);
    assert.equal((await Task.findById(completed._id).lean()).assignedUser, '');
});

test('DELETE task cleans user reference; DELETE user unassigns pending and completed tasks', async () => {
    const user = (await postUser({ email: 'delete@example.com' }).expect(201)).body.data;
    const pending = (await postTask({ assignedUser: user._id }).expect(201)).body.data;
    await request(app).delete(`/api/tasks/${pending._id}`).expect(204);
    assert.equal(await Task.findById(pending._id), null);
    await request(app).get(`/api/tasks/${pending._id}`).expect(404);
    assert.deepEqual((await User.findById(user._id).lean()).pendingTasks, []);

    const pendingTwo = (await postTask({ assignedUser: user._id }).expect(201)).body.data;
    const completed = (await postTask({ assignedUser: user._id, completed: true }).expect(201)).body.data;
    await request(app).delete(`/api/users/${user._id}`).expect(204);
    assert.equal(await User.findById(user._id), null);
    await request(app).get(`/api/users/${user._id}`).expect(404);
    for (const id of [pendingTwo._id, completed._id]) {
        const task = await Task.findById(id).lean();
        assert.equal(task.assignedUser, '');
        assert.equal(task.assignedUserName, 'unassigned');
    }

    await request(app).delete('/api/tasks/not-an-id').expect(404);
    await request(app).delete('/api/users/not-an-id').expect(404);
    await request(app).delete(`/api/users/${new mongoose.Types.ObjectId()}`).expect(404);
});
