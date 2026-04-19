export const BROWSER_TOOLS = [
  {
    name: "javascript_tool",
    description:
      "在当前页面上下文中执行 JavaScript 代码。代码将在页面上下文中运行，并可与 DOM、window 对象和页面变量交互。返回最后一个表达式的结果或任何抛出的错误。如果没有有效的标签页 ID，请先使用 tabs_context_mcp 获取可用标签页。",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description: "必须设置为 'javascript_exec'",
        },
        text: {
          type: "string",
          description:
            "要执行的 JavaScript 代码。代码将在页面上下文中求值。最后一个表达式的结果将自动返回。请勿使用 'return' 语句——只需编写要计算的表达式（例如，使用 'window.myData.value' 而不是 'return window.myData.value'）。您可以访问和修改 DOM、调用页面函数以及与页面变量交互。",
        },
        tabId: {
          type: "number",
          description:
            "要在其中执行代码的标签页 ID。必须是当前分组中的一个标签页。如果没有有效的标签页 ID，请先使用 tabs_context_mcp。",
        },
      },
      required: ["action", "text", "tabId"],
    },
  },
  {
    name: "read_page",
    description:
      "获取页面上元素的可访问性树表示。默认返回所有元素，包括不可见的元素。输出默认限制为 50000 个字符。如果输出超过此限制，您将收到错误提示，要求您指定较小的深度或使用 ref_id 专注于特定元素。可选地仅筛选交互式元素。如果没有有效的标签页 ID，请先使用 tabs_context_mcp 获取可用标签页。",
    inputSchema: {
      type: "object",
      properties: {
        filter: {
          type: "string",
          enum: ["interactive", "all"],
          description:
            '筛选元素："interactive" 仅用于按钮/链接/输入框，"all" 用于所有元素包括不可见的元素（默认：所有元素）',
        },
        tabId: {
          type: "number",
          description:
            "要读取的标签页 ID。必须是当前分组中的一个标签页。如果没有有效的标签页 ID，请先使用 tabs_context_mcp。",
        },
        depth: {
          type: "number",
          description:
            "要遍历的树的最大深度（默认：15）。如果输出过大，请使用较小的深度。",
        },
        ref_id: {
          type: "string",
          description:
            "要读取的父元素的引用 ID。将返回指定元素及其所有子元素。当输出过大时，使用此参数可专注于页面的特定部分。",
        },
        max_chars: {
          type: "number",
          description:
            "输出的最大字符数（默认：50000）。如果您的客户端可以处理大量输出，请设置为更高的值。",
        },
      },
      required: ["tabId"],
    },
  },
  {
    name: "find",
    description:
      '使用自然语言查找页面上的元素。可以根据元素用途（例如，“搜索栏”、“登录按钮”）或文本内容（例如，“有机芒果产品”）进行搜索。返回最多 20 个匹配元素及其引用，这些引用可用于其他工具。如果存在超过 20 个匹配项，您将收到通知，要求使用更具体的查询。如果没有有效的标签页 ID，请先使用 tabs_context_mcp 获取可用标签页。',
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            '要查找内容的自然语言描述（例如，“搜索栏”、“添加到购物车按钮”、“包含有机字样的产品标题”）',
        },
        tabId: {
          type: "number",
          description:
            "要在其中搜索的标签页 ID。必须是当前分组中的一个标签页。如果没有有效的标签页 ID，请先使用 tabs_context_mcp。",
        },
      },
      required: ["query", "tabId"],
    },
  },
  {
    name: "form_input",
    description:
      "使用来自 read_page 工具的元素引用 ID 设置表单元素的值。如果没有有效的标签页 ID，请先使用 tabs_context_mcp 获取可用标签页。",
    inputSchema: {
      type: "object",
      properties: {
        ref: {
          type: "string",
          description:
            '来自 read_page 工具的元素引用 ID（例如，“ref_1”、“ref_2”）',
        },
        value: {
          type: ["string", "boolean", "number"],
          description:
            "要设置的值。对于复选框使用布尔值，对于选择框使用选项值或文本，对于其他输入框使用适当的字符串/数字",
        },
        tabId: {
          type: "number",
          description:
            "要在其中设置表单值的标签页 ID。必须是当前分组中的一个标签页。如果没有有效的标签页 ID，请先使用 tabs_context_mcp。",
        },
      },
      required: ["ref", "value", "tabId"],
    },
  },
  {
    name: "computer",
    description: `使用鼠标和键盘与网页浏览器交互，并截取屏幕截图。如果没有有效的标签页 ID，请先使用 tabs_context_mcp 获取可用标签页。
* 每当您打算点击图标等元素时，应在移动光标前查看截图以确定元素的坐标。
* 如果您尝试点击程序或链接但加载失败，即使在等待后，请尝试调整点击位置，使光标尖端视觉上落在您想要点击的元素上。
* 确保点击任何按钮、链接、图标等时，光标尖端位于元素的中心。除非被要求，否则不要点击框的边缘。`,
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "left_click",
            "right_click",
            "type",
            "screenshot",
            "wait",
            "scroll",
            "key",
            "left_click_drag",
            "double_click",
            "triple_click",
            "zoom",
            "scroll_to",
            "hover",
          ],
          description:
            "要执行的操作：\n* `left_click`：在指定坐标处点击鼠标左键。\n* `right_click`：在指定坐标处点击鼠标右键以打开上下文菜单。\n* `double_click`：在指定坐标处双击鼠标左键。\n* `triple_click`：在指定坐标处三击鼠标左键。\n* `type`：输入一串文本。\n* `screenshot`：截取屏幕截图。\n* `wait`：等待指定的秒数。\n* `scroll`：在指定坐标处向上、向下、向左或向右滚动。\n* `key`：按下特定的键盘按键。\n* `left_click_drag`：从 start_coordinate 拖拽到 coordinate。\n* `zoom`：截取特定区域的截图以便更仔细地检查。\n* `scroll_to`：使用来自 read_page 或 find 工具的元素引用 ID 将元素滚动到视图中。\n* `hover`：将鼠标光标移动到指定坐标或元素上而不点击。用于显示工具提示、下拉菜单或触发悬停状态。",
        },
        coordinate: {
          type: "array",
          items: { type: "number" },
          minItems: 2,
          maxItems: 2,
          description:
            "(x, y)：x（距离左侧边缘的像素数）和 y（距离顶部边缘的像素数）坐标。`left_click`、`right_click`、`double_click`、`triple_click` 和 `scroll` 操作需要此参数。对于 `left_click_drag`，这是结束位置。",
        },
        text: {
          type: "string",
          description:
            '要输入的文本（用于 `type` 操作）或要按下的按键（用于 `key` 操作）。对于 `key` 操作：提供以空格分隔的按键（例如，“Backspace Backspace Delete”）。支持使用平台的修饰键进行键盘快捷键（在 Mac 上使用“cmd”，在 Windows/Linux 上使用“ctrl”，例如，“cmd+a”或“ctrl+a”表示全选）。',
        },
        duration: {
          type: "number",
          minimum: 0,
          maximum: 30,
          description:
            "要等待的秒数。`wait` 操作需要此参数。最多 30 秒。",
        },
        scroll_direction: {
          type: "string",
          enum: ["up", "down", "left", "right"],
          description: "滚动的方向。`scroll` 操作需要此参数。",
        },
        scroll_amount: {
          type: "number",
          minimum: 1,
          maximum: 10,
          description:
            "滚轮滚动的刻度数。`scroll` 操作可选，默认为 3。",
        },
        start_coordinate: {
          type: "array",
          items: { type: "number" },
          minItems: 2,
          maxItems: 2,
          description:
            "(x, y)：`left_click_drag` 操作的起始坐标。",
        },
        region: {
          type: "array",
          items: { type: "number" },
          minItems: 4,
          maxItems: 4,
          description:
            "(x0, y0, x1, y1)：`zoom` 操作要捕获的矩形区域。坐标定义了从左上角 (x0, y0) 到右下角 (x1, y1) 的矩形，单位为相对于视口原点的像素数。`zoom` 操作需要此参数。适用于检查小 UI 元素，如图标、按钮或文本。",
        },
        repeat: {
          type: "number",
          minimum: 1,
          maximum: 100,
          description:
            "重复按键序列的次数。仅适用于 `key` 操作。必须是 1 到 100 之间的正整数。默认为 1。适用于导航任务，如多次按下箭头键。",
        },
        ref: {
          type: "string",
          description:
            '来自 read_page 或 find 工具的元素引用 ID（例如，“ref_1”、“ref_2”）。`scroll_to` 操作需要此参数。也可用作点击操作中 `coordinate` 的替代方案。',
        },
        modifiers: {
          type: "string",
          description:
            '点击操作的修饰键。支持：“ctrl”、“shift”、“alt”、“cmd”（或“meta”）、“win”（或“windows”）。可以使用“+”组合（例如，“ctrl+shift”、“cmd+alt”）。可选。',
        },
        tabId: {
          type: "number",
          description:
            "要在其上执行操作的标签页 ID。必须是当前分组中的一个标签页。如果没有有效的标签页 ID，请先使用 tabs_context_mcp。",
        },
      },
      required: ["action", "tabId"],
    },
  },
  {
    name: "navigate",
    description:
      "导航到指定 URL，或在浏览器历史记录中前进/后退。如果没有有效的标签页 ID，请先使用 tabs_context_mcp 获取可用标签页。",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description:
            '要导航到的 URL。可提供带或不带协议（默认为 https://）。使用 "forward" 在历史记录中前进，或使用 "back" 后退。',
        },
        tabId: {
          type: "number",
          description:
            "要导航的标签页 ID。必须是当前分组内的标签页。如果没有有效的标签页 ID，请先使用 tabs_context_mcp。",
        },
      },
      required: ["url", "tabId"],
    },
  },
  {
    name: "resize_window",
    description:
      "将当前浏览器窗口调整为指定尺寸。适用于测试响应式设计或设置特定屏幕尺寸。如果没有有效的标签页 ID，请先使用 tabs_context_mcp 获取可用标签页。",
    inputSchema: {
      type: "object",
      properties: {
        width: {
          type: "number",
          description: "目标窗口宽度（像素）",
        },
        height: {
          type: "number",
          description: "目标窗口高度（像素）",
        },
        tabId: {
          type: "number",
          description:
            "要获取其窗口的标签页 ID。必须是当前分组内的标签页。如果没有有效的标签页 ID，请先使用 tabs_context_mcp。",
        },
      },
      required: ["width", "height", "tabId"],
    },
  },
  {
    name: "gif_creator",
    description:
      "管理浏览器自动化会话的 GIF 录制和导出。控制何时开始/停止录制浏览器操作（点击、滚动、导航），然后导出为带有视觉叠加层（点击指示器、操作标签、进度条、水印）的动画 GIF。所有操作都限定在标签页分组内。开始录制时，立即截取一张屏幕截图以捕获初始状态作为第一帧。停止录制时，立即截取一张屏幕截图以捕获最终状态作为最后一帧。对于导出，可提供 'coordinate' 以拖放上传到页面元素，或设置 'download: true' 以下载 GIF。",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["start_recording", "stop_recording", "export", "clear"],
          description:
            "要执行的操作：'start_recording'（开始捕获）、'stop_recording'（停止捕获但保留帧）、'export'（生成并导出 GIF）、'clear'（丢弃帧）",
        },
        tabId: {
          type: "number",
          description:
            "标签页 ID，用于标识此操作适用于哪个标签页分组",
        },
        download: {
          type: "boolean",
          description:
            "仅针对 'export' 操作，请始终将此设置为 true。这将导致 GIF 在浏览器中被下载。",
        },
        filename: {
          type: "string",
          description:
            "导出 GIF 的可选文件名（默认：'recording-[timestamp].gif'）。仅适用于 'export' 操作。",
        },
        options: {
          type: "object",
          description:
            "针对 'export' 操作的可选 GIF 增强选项。属性：showClickIndicators (bool)、showDragPaths (bool)、showActionLabels (bool)、showProgressBar (bool)、showWatermark (bool)、quality (number 1-30)。除 quality 外，其余默认均为 true（quality 默认值：10）。",
          properties: {
            showClickIndicators: {
              type: "boolean",
              description:
                "在点击位置显示橙色圆圈（默认：true）",
            },
            showDragPaths: {
              type: "boolean",
              description: "为拖拽操作显示红色箭头（默认：true）",
            },
            showActionLabels: {
              type: "boolean",
              description:
                "显示描述操作的黑色标签（默认：true）",
            },
            showProgressBar: {
              type: "boolean",
              description: "在底部显示橙色进度条（默认：true）",
            },
            showWatermark: {
              type: "boolean",
              description: "显示 Claude 徽标水印（默认：true）",
            },
            quality: {
              type: "number",
              description:
                "GIF 压缩质量，1-30（数值越低，质量越好，编码越慢）。默认：10",
            },
          },
        },
      },
      required: ["action", "tabId"],
    },
  },
  {
    name: "upload_image",
    description:
      "将先前捕获的屏幕截图或用户上传的图片上传到文件输入框或拖放目标。支持两种方法：(1) ref - 用于定位特定元素，尤其是隐藏的文件输入框；(2) coordinate - 用于拖放到可见位置（如 Google Docs）。请提供 ref 或 coordinate 之一，不要同时提供。",
    inputSchema: {
      type: "object",
      properties: {
        imageId: {
          type: "string",
          description:
            "先前捕获的屏幕截图（来自 computer 工具的截图操作）或用户上传图片的 ID",
        },
        ref: {
          type: "string",
          description:
            '来自 read_page 或 find 工具的元素引用 ID（例如 "ref_1"、"ref_2"）。用于文件输入框（尤其是隐藏的）或特定元素。请提供 ref 或 coordinate 之一，不要同时提供。',
        },
        coordinate: {
          type: "array",
          items: {
            type: "number",
          },
          description:
            "用于拖放到可见位置的视口坐标 [x, y]。用于 Google Docs 等拖放目标。请提供 ref 或 coordinate 之一，不要同时提供。",
        },
        tabId: {
          type: "number",
          description:
            "目标元素所在的标签页 ID。图片将上传到此标签页。",
        },
        filename: {
          type: "string",
          description:
            '上传文件的可选文件名（默认："image.png"）',
        },
      },
      required: ["imageId", "tabId"],
    },
  },
  {
    name: "get_page_text",
    description:
      "从页面提取原始文本内容，优先提取文章内容。适用于阅读文章、博客帖子或其他文本密集型页面。返回纯文本，不含 HTML 格式。如果没有有效的标签页 ID，请先使用 tabs_context_mcp 获取可用标签页。",
    inputSchema: {
      type: "object",
      properties: {
        tabId: {
          type: "number",
          description:
            "要从中提取文本的标签页 ID。必须是当前分组内的标签页。如果没有有效的标签页 ID，请先使用 tabs_context_mcp。",
        },
      },
      required: ["tabId"],
    },
  },
  {
    name: "tabs_context_mcp",
    title: "标签页上下文",
    description:
      "获取当前 MCP 标签页分组的上下文信息。如果分组存在，则返回组内所有标签页 ID。关键提示：在使用其他浏览器自动化工具之前，必须至少获取一次上下文，以便了解存在哪些标签页。每次新对话都应创建自己的新标签页（使用 tabs_create_mcp），而不是重用现有标签页，除非用户明确要求使用现有标签页。",
    inputSchema: {
      type: "object",
      properties: {
        createIfEmpty: {
          type: "boolean",
          description:
            "如果不存在 MCP 标签页分组，则创建一个新的 MCP 标签页分组，创建一个包含新标签页分组（其中包含一个空标签页）的新窗口（可用于此对话）。如果 MCP 标签页分组已存在，则此参数无效。",
        },
      },
      required: [],
    },
  },
  {
    name: "tabs_create_mcp",
    title: "标签页创建",
    description:
      "在 MCP 标签页组中创建一个新的空白标签页。重要提示：在使用其他浏览器自动化工具之前，你必须至少使用一次 tabs_context_mcp 来获取上下文，以便了解存在哪些标签页。",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "update_plan",
    description:
      "在采取行动之前，向用户展示一个计划以获取批准。用户将看到你打算访问的域名以及你的方法。一旦获得批准，你就可以对已批准的域名执行操作，无需额外的权限提示。",
    inputSchema: {
      type: "object" as const,
      properties: {
        domains: {
          type: "array" as const,
          items: { type: "string" as const },
          description:
            "你将访问的域名列表（例如，['github.com', 'stackoverflow.com']）。当用户接受计划时，这些域名将在会话中被批准。",
        },
        approach: {
          type: "array" as const,
          items: { type: "string" as const },
          description:
            "关于你将做什么的高级描述。专注于结果和关键行动，而不是实现细节。保持简洁——目标是 3-7 个项目。",
        },
      },
      required: ["domains", "approach"],
    },
  },
  {
    name: "read_console_messages",
    description:
      "从特定标签页读取浏览器控制台消息（console.log、console.error、console.warn 等）。用于调试 JavaScript 错误、查看应用程序日志或了解浏览器控制台中发生的情况。仅返回来自当前域的控制台消息。如果你没有有效的标签页 ID，请先使用 tabs_context_mcp 获取可用的标签页。重要提示：始终提供一个模式来过滤消息——没有模式，你可能会收到太多不相关的消息。",
    inputSchema: {
      type: "object",
      properties: {
        tabId: {
          type: "number",
          description:
            "要从中读取控制台消息的标签页 ID。必须是当前组中的一个标签页。如果你没有有效的标签页 ID，请先使用 tabs_context_mcp。",
        },
        onlyErrors: {
          type: "boolean",
          description:
            "如果为 true，则仅返回错误和异常消息。默认为 false（返回所有消息类型）。",
        },
        clear: {
          type: "boolean",
          description:
            "如果为 true，则在读取后清除控制台消息，以避免后续调用中出现重复。默认为 false。",
        },
        pattern: {
          type: "string",
          description:
            "用于过滤控制台消息的正则表达式模式。只有匹配此模式的消息才会被返回（例如，'error|warning' 用于查找错误和警告，'MyApp' 用于过滤特定于应用程序的日志）。你应该始终提供一个模式，以避免收到太多不相关的消息。",
        },
        limit: {
          type: "number",
          description:
            "要返回的最大消息数。默认为 100。仅在需要更多结果时增加。",
        },
      },
      required: ["tabId"],
    },
  },
  {
    name: "read_network_requests",
    description:
      "从特定标签页读取 HTTP 网络请求（XHR、Fetch、文档、图像等）。用于调试 API 调用、监控网络活动或了解页面正在发出哪些请求。返回当前页面发出的所有网络请求，包括跨域请求。当页面导航到不同域时，请求会自动清除。如果你没有有效的标签页 ID，请先使用 tabs_context_mcp 获取可用的标签页。",
    inputSchema: {
      type: "object",
      properties: {
        tabId: {
          type: "number",
          description:
            "要从中读取网络请求的标签页 ID。必须是当前组中的一个标签页。如果你没有有效的标签页 ID，请先使用 tabs_context_mcp。",
        },
        urlPattern: {
          type: "string",
          description:
            "用于过滤请求的可选 URL 模式。仅返回 URL 包含此字符串的请求（例如，'/api/' 用于过滤 API 调用，'example.com' 用于按域名过滤）。",
        },
        clear: {
          type: "boolean",
          description:
            "如果为 true，则在读取后清除网络请求，以避免后续调用中出现重复。默认为 false。",
        },
        limit: {
          type: "number",
          description:
            "要返回的最大请求数。默认为 100。仅在需要更多结果时增加。",
        },
      },
      required: ["tabId"],
    },
  },
  {
    name: "shortcuts_list",
    description:
      "列出所有可用的快捷方式和流程（快捷方式和流程可互换使用）。返回包含其命令、描述以及是否为流程的快捷方式。使用 shortcuts_execute 来运行快捷方式或流程。",
    inputSchema: {
      type: "object",
      properties: {
        tabId: {
          type: "number",
          description:
            "要从中列出快捷方式的标签页 ID。必须是当前组中的一个标签页。如果你没有有效的标签页 ID，请先使用 tabs_context_mcp。",
        },
      },
      required: ["tabId"],
    },
  },
  {
    name: "shortcuts_execute",
    description:
      "通过在当前标签页的新侧面板窗口中运行来执行快捷方式或流程（快捷方式和流程可互换使用）。先使用 shortcuts_list 查看可用的快捷方式。这会开始执行并立即返回——它不会等待完成。",
    inputSchema: {
      type: "object",
      properties: {
        tabId: {
          type: "number",
          description:
            "要在其上执行快捷方式的标签页 ID。必须是当前组中的一个标签页。如果你没有有效的标签页 ID，请先使用 tabs_context_mcp。",
        },
        shortcutId: {
          type: "string",
          description: "要执行的快捷方式的 ID",
        },
        command: {
          type: "string",
          description:
            "要执行的快捷方式的命令名称（例如，'debug'、'summarize'）。不要包含前导斜杠。",
        },
      },
      required: ["tabId"],
    },
  },
  {
    name: "switch_browser",
    description:
      "切换用于浏览器自动化的 Chrome 浏览器。当用户想要连接到不同的 Chrome 浏览器时调用此功能。向所有安装了扩展程序的 Chrome 浏览器广播连接请求——用户在所需的浏览器中点击“连接”。",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
];
