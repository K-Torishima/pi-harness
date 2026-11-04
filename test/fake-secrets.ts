// Fake secrets for tests, assembled at run time so no file in this repo looks like it holds one
export const FAKE = {
	github: `ghp_${"a1B2".repeat(9)}`,
	aws: `AKIA${"ABCD1234".repeat(2)}`,
	slack: `xoxb-${"1234567890"}-abcdefghij`,
	anthropic: `sk-ant-${"x9".repeat(20)}`,
	key: ["-----BEGIN OPENSSH PRIVATE", " KEY-----\nAAAAB3Nza\n-----END OPENSSH PRIVATE", " KEY-----"].join(""),
};
