import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ExplorationToolContext } from "./types.js";
import {
  getExplorationStartHandler,
  getExplorationEndHandler,
} from "./tools-session.js";
import {
  getPageSummaryHandler,
  askAboutScreenHandler,
  aiActHandler,
} from "./tools-intelligent.js";
import {
  getScreenshotHandler,
  getTypeHandler,
  getWaitHandler,
} from "./tools-atomic.js";

function jsonResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

/**
 * Register all exploration MCP tools on the given server instance.
 * Handlers are created once at the top and reused for each tool registration.
 */
export function registerExplorationTools(
  server: McpServer,
  ctx: ExplorationToolContext,
): void {
  // Instantiate all handler functions once
  const startHandler = getExplorationStartHandler(ctx);
  const endHandler = getExplorationEndHandler();
  const pageSummaryHandler = getPageSummaryHandler(ctx);
  const askHandler = askAboutScreenHandler(ctx);
  const actHandler = aiActHandler(ctx);
  const screenshotHandler = getScreenshotHandler(ctx);
  const typeHandler = getTypeHandler(ctx);
  const waitHandler = getWaitHandler(ctx);

  // ---------------------------------------------------------------------------
  // 1. exploration_start
  // ---------------------------------------------------------------------------
  server.registerTool(
    "exploration_start",
    {
      title: "Start Exploration",
      description:
        "Start an interactive exploration session on a connected device. For iOS, automatically starts WebDriverAgent (WDA) if not already running. Creates a persistent device connection for the LLM to explore the app UI before generating test cases. Returns a sessionId that must be passed to subsequent exploration_* tools. Session auto-expires after 30 minutes of inactivity.",
      inputSchema: {
        resourceId: z
          .string()
          .optional()
          .describe(
            "Device resource ID from list_devices (e.g., android:emulator-5554). If omitted, the first available device is used.",
          ),
        appRef: z
          .string()
          .optional()
          .describe(
            "App to launch. Can be a bundleId (e.g., com.example.app) or an installable URL/path (.apk/.ipa). If omitted, the current app state is used.",
          ),
      },
    },
    async (input) => jsonResult(await startHandler(input)),
  );

  // ---------------------------------------------------------------------------
  // 2. exploration_end
  // ---------------------------------------------------------------------------
  server.registerTool(
    "exploration_end",
    {
      title: "End Exploration",
      description:
        "End an exploration session and release the device connection. Always call this when done.",
      inputSchema: {
        sessionId: z.string().describe("Session ID from exploration_start"),
      },
    },
    async (input) => jsonResult(await endHandler(input)),
  );

  // ---------------------------------------------------------------------------
  // 3. exploration_get_page_summary
  // ---------------------------------------------------------------------------
  server.registerTool(
    "exploration_get_page_summary",
    {
      title: "Get Page Summary",
      description:
        "Get a natural language summary of the current screen, including layout type (fixed single-screen / scrollable long page / multi-tab / list). Call this first when entering a new page to understand its structure before acting. Use this INSTEAD of ai_act if you just want to observe — ai_act is for changing state, not for looking around.",
      inputSchema: {
        sessionId: z.string().describe("Session ID from exploration_start"),
      },
    },
    async (input) => jsonResult(await pageSummaryHandler(input)),
  );

  // ---------------------------------------------------------------------------
  // 4. exploration_ask_about_screen
  // ---------------------------------------------------------------------------
  server.registerTool(
    "exploration_ask_about_screen",
    {
      title: "Ask About Screen",
      description:
        "Ask a specific question about the current screen. Examples: 'What color is the submit button?'",
      inputSchema: {
        sessionId: z.string().describe("Session ID from exploration_start"),
        question: z
          .string()
          .describe("Your question about the current screen"),
      },
    },
    async (input) => jsonResult(await askHandler(input)),
  );

  // ---------------------------------------------------------------------------
  // 5. exploration_ai_act
  // ---------------------------------------------------------------------------
  server.registerTool(
    "exploration_ai_act",
    {
      title: "AI Act",
      description:
        "Perform a high-level UI interaction described in natural language. Examples: 'Go back', 'Tap the settings icon', 'Type text in the search box'. After execution, returns a summary of the new page state including whether the action actually changed anything.\n\nIMPORTANT: Use get_page_summary FIRST to check if the page is a fixed single-screen layout. If it is, do NOT request scroll actions — there is nothing to scroll to. Use ai_act only for meaningful interactions (tap, type, swipe between tabs), not for 'look around' or 'scroll to see more'. If the post-action summary reports that the page did not change, stop acting on this page and move on.",
      inputSchema: {
        sessionId: z.string().describe("Session ID from exploration_start"),
        intent: z.string().describe("Description of what to do"),
      },
    },
    async (input) => jsonResult(await actHandler(input)),
  );

  // ---------------------------------------------------------------------------
  // 6. exploration_screenshot
  // ---------------------------------------------------------------------------
  server.registerTool(
    "exploration_screenshot",
    {
      title: "Take Screenshot",
      description:
        "Take a screenshot of the current device screen and return it as base64.",
      inputSchema: {
        sessionId: z.string().describe("Session ID from exploration_start"),
      },
    },
    async (input) => {
      const { screenshot, mimeType } = await screenshotHandler(input);
      return {
        content: [
          { type: "image", data: screenshot, mimeType },
        ],
      };
    },
  );

  // ---------------------------------------------------------------------------
  // 7. exploration_type
  // ---------------------------------------------------------------------------
  server.registerTool(
    "exploration_type",
    {
      title: "Type Text",
      description: "Type text into the currently focused input field.",
      inputSchema: {
        sessionId: z.string().describe("Session ID from exploration_start"),
        text: z.string().describe("The text to type"),
      },
    },
    async (input) => jsonResult(await typeHandler(input)),
  );

  // ---------------------------------------------------------------------------
  // 8. exploration_wait
  // ---------------------------------------------------------------------------
  server.registerTool(
    "exploration_wait",
    {
      title: "Wait",
      description:
        "Wait for a specified duration in milliseconds (max 10000). Use after actions that trigger animations or page transitions.",
      inputSchema: {
        sessionId: z.string().describe("Session ID from exploration_start"),
        ms: z
          .number()
          .int()
          .min(0)
          .max(10000)
          .describe("Duration to wait in ms"),
      },
    },
    async (input) => jsonResult(await waitHandler(input)),
  );
}
