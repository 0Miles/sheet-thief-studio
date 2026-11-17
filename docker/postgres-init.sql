-- Run once, when the dev Postgres starts on an empty volume (compose.dev.yaml).
-- `studio` is the development database; these two belong to the tests, which empty them.
CREATE DATABASE studio_test OWNER studio;
CREATE DATABASE studio_e2e OWNER studio;
