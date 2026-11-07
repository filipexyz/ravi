import { expect, it } from "bun:test";
import { which } from "bun";
import { spawn } from "node:child_process";
import { connect, type NatsConnection } from "nats";
import { GH_PR_FOLLOW_TOPIC } from "../hooks/gh-watch.js";
import { eventSubject } from "../watch/connectors.js";

const server = which("nats-server");
const brokerTest = server ? it : it.skip;
brokerTest(
  "delivers PR, CI and comment subjects through the follow pattern on a real isolated NATS broker",
  async () => {
    // No JetStream, files or production connection. Port -1 asks NATS for an ephemeral port.
    const child = spawn(server!, ["-a", "127.0.0.1", "-p", "-1"], { stdio: ["ignore", "ignore", "pipe"] });
    let connection: NatsConnection | undefined;
    try {
      const port = await new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Isolated NATS broker did not start")), 3000);
        let output = "";
        child.once("error", (error) => {
          clearTimeout(timeout);
          reject(error);
        });
        child.stderr!.on("data", (bytes: Buffer) => {
          output = (output + bytes.toString()).slice(-4096);
          const match = /Listening for client connections on 127\.0\.0\.1:(\d+)/.exec(output);
          if (match) {
            clearTimeout(timeout);
            resolve(match[1]!);
          }
        });
      });
      connection = await connect({ servers: `127.0.0.1:${port}`, timeout: 1000 });
      const received: string[] = [];
      const obsolete: string[] = [];
      connection.subscribe(GH_PR_FOLLOW_TOPIC, {
        callback: (error, msg) => {
          if (error) throw error;
          received.push(msg.subject);
        },
      });
      connection.subscribe("ravi.watch.github.*", {
        callback: (error, msg) => {
          if (error) throw error;
          obsolete.push(msg.subject);
        },
      });
      await connection.flush();
      const subjects = ["pull_request.opened", "workflow_run.completed", "pull_request_comment.created"].map((event) =>
        eventSubject("github", event),
      );
      for (const subject of subjects) connection.publish(subject, new Uint8Array());
      await connection.flush();
      expect(received).toEqual(subjects);
      expect(obsolete).toEqual([]);
    } finally {
      await connection?.close();
      child.kill("SIGTERM");
    }
  },
);
