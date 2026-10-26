# Testing Guide

The integration suite starts a temporary MongoDB replica set and sends real HTTP
requests through the Express application. No Atlas credentials or `.env` file are
needed for tests.

```bash
npm install
npm test
```

For a built-in line/branch/function coverage report:

```bash
npm run test:coverage
```

Use Node 24 LTS, matching the assignment and deployment runtime.

## Coverage map

| Requirement | Covered scenarios |
| --- | --- |
| Response format | Success and error responses contain `message` and `data`; malformed JSON and unexpected database failures do not leak framework/database errors |
| User creation | Required fields, wrong types, defaults, duplicate email, ignored client `dateCreated`, malformed and missing task references |
| Task creation | Required fields, wrong types, defaults, assignee existence, assignee-name consistency, pending-task synchronization |
| Single-resource GET | Existing, missing, malformed id, and `select` projection for users and tasks |
| Collection GET | Combined `where`, `sort`, `select`, `skip`, `limit`, and `count`; invalid parameters; empty result; default task limit and unlimited users |
| User replacement | Preserved `dateCreated`, omitted `pendingTasks`, task movement, removed-task unassignment, rename propagation to pending and completed tasks |
| Task replacement | Preserved `dateCreated`, replacement defaults, completion, reopening, moving, and unassigning |
| Failure atomicity | Validation/reference failures leave users and tasks unchanged; URL-id checks have first precedence |
| Deletion | Task deletion removes its user reference; user deletion unassigns pending and completed tasks; missing ids return `404` |

The suite uses a replica set because production write operations use MongoDB
transactions to keep Task/User changes atomic.
