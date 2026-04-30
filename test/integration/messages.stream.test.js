import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RefreshTokenExpiredError } from "../../src/errors/authErrors.js";
import messagesRouter from "../../src/routes/messages.js";
import * as hopgptClientModule from "../../src/services/hopgptClient.js";

function makeSSEResponse(body) {
	const encoder = new TextEncoder();
	const stream = new ReadableStream({
		start(controller) {
			controller.enqueue(encoder.encode(body));
			controller.close();
		},
	});
	return {
		ok: true,
		status: 200,
		statusText: "OK",
		headers: {
			get: (k) =>
				k.toLowerCase() === "content-type" ? "text/event-stream" : null,
		},
		body: stream,
		text: async () => body,
		json: async () => {
			throw new Error("not json");
		},
	};
}

function buildApp() {
	const app = express();
	app.use(express.json());
	app.use("/v1", messagesRouter);
	return app;
}

describe("POST /v1/messages streaming — end-to-end", () => {
	let getDefaultClientSpy;
	let originalIdlePingDelay;
	beforeEach(() => {
		originalIdlePingDelay = process.env.HOPGPT_STREAM_IDLE_PING_DELAY_MS;
		getDefaultClientSpy = vi.spyOn(hopgptClientModule, "getDefaultClient");
	});
	afterEach(() => {
		if (originalIdlePingDelay === undefined) {
			delete process.env.HOPGPT_STREAM_IDLE_PING_DELAY_MS;
		} else {
			process.env.HOPGPT_STREAM_IDLE_PING_DELAY_MS = originalIdlePingDelay;
		}
		vi.restoreAllMocks();
	});

	it("streams Anthropic SSE from a HAR-shaped HopGPT SSE input", async () => {
		// Matches the event sequence in chat.ai.jh.edu_chat_message.har
		const harSSE =
			'event: message\ndata: {"created":true,"message":{"messageId":"m1","parentMessageId":"0","conversationId":"c1","sender":"User","text":"hi","isCreatedByUser":true,"tokenCount":5},"streamId":"c1"}\n\n' +
			'event: message\ndata: {"event":"on_run_step","data":{"stepIndex":0,"id":"step_1","type":"message_creation","index":0,"stepDetails":{"type":"message_creation","message_creation":{"message_id":"msg_1"}},"usage":null,"runId":"r1"}}\n\n' +
			'event: message\ndata: {"event":"on_message_delta","data":{"id":"step_1","delta":{"content":[{"type":"text","text":"Hi"}]}}}\n\n' +
			'event: message\ndata: {"event":"on_message_delta","data":{"id":"step_1","delta":{"content":[{"type":"text","text":" there"}]}}}\n\n' +
			'event: message\ndata: {"event":"on_message_delta","data":{"id":"step_1","delta":{"content":[{"type":"text","text":"! How can I help you today?"}]}}}\n\n' +
			'event: message\ndata: {"final":true,"conversation":{"conversationId":"c1"},"requestMessage":{"messageId":"m1","conversationId":"c1","sender":"User","text":"hi","isCreatedByUser":true,"tokenCount":5},"responseMessage":{"messageId":"r1","conversationId":"c1","parentMessageId":"m1","isCreatedByUser":false,"model":"claude-opus-4.5","sender":"Claude","promptTokens":8,"endpoint":"AnthropicClaude","text":"","content":[{"type":"text","text":"Hi there! How can I help you today?"}],"attachments":[]}}\n\n';

		getDefaultClientSpy.mockReturnValue({
			validateAuth: () => ({ valid: true, missing: [], warnings: [] }),
			sendMessage: async () => makeSSEResponse(harSSE),
		});

		const app = buildApp();
		const res = await request(app)
			.post("/v1/messages")
			.send({
				model: "claude-opus-4-5",
				max_tokens: 128,
				stream: true,
				messages: [{ role: "user", content: "hi" }],
			});

		expect(res.status).toBe(200);
		expect(res.headers["content-type"]).toMatch(/text\/event-stream/);

		const body = res.text;
		expect(body).toMatch(/event: message_start/);
		expect(body).toMatch(/event: content_block_start/);
		expect(body).toMatch(/event: content_block_delta/);
		expect(body).toMatch(/event: message_stop/);

		// Assert the concatenation of all text_delta chunks equals the expected final text.
		const deltaTexts = [];
		const lines = body.split("\n");
		for (let i = 0; i < lines.length; i++) {
			if (
				lines[i] === "event: content_block_delta" &&
				lines[i + 1]?.startsWith("data: ")
			) {
				try {
					const data = JSON.parse(lines[i + 1].slice("data: ".length));
					if (data.delta?.type === "text_delta") {
						deltaTexts.push(data.delta.text);
					}
				} catch {
					// ignore non-JSON data lines
				}
			}
		}
		expect(deltaTexts.join("")).toBe("Hi there! How can I help you today?");
	});

	it("sends message_start before upstream content so slow Opus streams are not idle", async () => {
		const harSSE =
			'event: message\ndata: {"created":true,"message":{"messageId":"m1","conversationId":"c1"}}\n\n' +
			'event: message\ndata: {"event":"on_message_delta","data":{"delta":{"content":[{"type":"text","text":"Hi"}]}}}\n\n' +
			'event: message\ndata: {"final":true,"conversation":{"conversationId":"c1"},"responseMessage":{"messageId":"r1","conversationId":"c1","content":[{"type":"text","text":"Hi"}]}}\n\n';

		process.env.HOPGPT_STREAM_IDLE_PING_DELAY_MS = "10";
		getDefaultClientSpy.mockReturnValue({
			validateAuth: () => ({ valid: true, missing: [], warnings: [] }),
			sendMessage: async () => {
				await new Promise((resolve) => setTimeout(resolve, 25));
				return makeSSEResponse(harSSE);
			},
		});

		const app = buildApp();
		const res = await request(app)
			.post("/v1/messages")
			.send({
				model: "claude-opus-4-5",
				max_tokens: 128,
				stream: true,
				messages: [{ role: "user", content: "hi" }],
			});

		expect(res.status).toBe(200);
		const messageStartIndex = res.text.indexOf("event: message_start");
		const contentBlockStartIndex = res.text.indexOf("event: content_block_start");
		expect(messageStartIndex).toBeGreaterThanOrEqual(0);
		expect(contentBlockStartIndex).toBeGreaterThan(messageStartIndex);
	});

	// Regression: a pre-stream failure (expired creds, CF block, network error)
	// used to flush SSE headers first, then write a lone `event: error` and end.
	// Vercel AI SDK's Anthropic provider chokes on that shape with
	// AI_JSONParseError(text="undefined"). The fix delays flushHeaders() until
	// the first HopGPT byte, so pre-stream errors return proper HTTP JSON.
	it("returns HTTP JSON error (not SSE) when sendMessage throws before the stream starts", async () => {
		getDefaultClientSpy.mockReturnValue({
			validateAuth: () => ({ valid: true, missing: [], warnings: [] }),
			sendMessage: async () => {
				throw new RefreshTokenExpiredError();
			},
		});

		const app = buildApp();
		const res = await request(app)
			.post("/v1/messages")
			.send({
				model: "claude-sonnet-4-5",
				max_tokens: 128,
				stream: true,
				messages: [{ role: "user", content: "hi" }],
			});

		expect(res.status).toBe(401);
		expect(res.headers["content-type"]).toMatch(/application\/json/);
		expect(res.headers["content-type"]).not.toMatch(/text\/event-stream/);
		expect(res.body?.type).toBe("error");
		expect(res.body?.error?.type).toBe("authentication_error");
		expect(res.body?.error?.message).toMatch(/Refresh token expired/);
	});
});
