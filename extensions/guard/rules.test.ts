/** The secret-related guard rules: what they block and what they leave alone */
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { load, matchCommand, matchPath } from "./index.ts";

const { compiled, error } = load();
const blocked = (cmd: string) => matchCommand(compiled, cmd)?.name;

test("rules load", () => assert.equal(error, undefined));

test("commands that print secrets are blocked", () => {
	assert.equal(blocked("aws secretsmanager get-secret-value --secret-id x"), "print a secret");
	assert.equal(blocked("gh auth token"), "print a secret");
	assert.equal(blocked("security find-generic-password -s svc -w"), "print a secret");
	assert.equal(blocked("op read op://vault/item/password"), "print a secret");
	assert.equal(blocked("kubectl get secret db -o yaml"), "print a secret");
	assert.equal(blocked("printenv"), "dump the environment");
	assert.equal(blocked("env | sort"), "dump the environment");
	assert.equal(blocked("cat ~/.aws/credentials"), "credential file");
	assert.equal(blocked("cat ~/.ssh/id_ed25519"), "credential file");
});

test("nearby safe commands are not blocked", () => {
	assert.equal(blocked("aws secretsmanager list-secrets"), undefined);
	assert.equal(blocked("gh auth status"), undefined);
	assert.equal(blocked("security find-generic-password -s svc"), undefined, "without -w it prints metadata only");
	assert.equal(blocked("printenv HOME"), undefined);
	assert.equal(blocked("env FOO=1 node app.js"), undefined);
	assert.equal(blocked("cat ~/.ssh/id_ed25519.pub"), undefined);
	assert.equal(blocked("kubectl get secrets"), undefined);
});

test("credential files are blocked for read tools, public keys are not", () => {
	assert.equal(matchPath(compiled, "read", join(homedir(), ".aws/credentials"))?.name, "credential file");
	assert.equal(matchPath(compiled, "read", join(homedir(), ".ssh/id_rsa"))?.name, "credential file");
	assert.equal(matchPath(compiled, "read", join(homedir(), ".ssh/id_rsa.pub")), undefined);
});
