/**
 * 服务器监控系统 - Cloudflare Worker后端
 *
 * 功能：
 * 1. 接收agent上报的监控数据
 * 2. 存储监控数据到KV
 * 3. 提供API查询服务器列表和监控数据
 * 4. 提供前端静态资源(待定)
 */

// 配置
const CONFIG = {
  // 认证密钥, 用于验证agent上报的数据, 通过Worker环境变量传入
  AUTH_KEY: "auth_key",

  // 数据保留时间（毫秒）
  // 默认保留1天的数据
  DATA_RETENTION_MS: 1 * 24 * 60 * 60 * 1000,

  // CORS配置
  CORS_HEADERS: {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  },
};

/**
 * 处理请求的主函数
 */
async function handleRequest(request) {
  const url = new URL(request.url);
  const path = url.pathname;

  // 处理OPTIONS请求（CORS预检）
  if (request.method === "OPTIONS") {
    return handleCORS();
  }

  // API路由
  if (path.startsWith("/api/")) {
    // 处理API请求
    return handleAPIRequest(request, path);
  }

  // 处理上报数据请求
  if (path === "/report" && request.method === "POST") {
    return handleReportData(request);
  }

  // 处理前端静态资源
  return handleStaticAsset(request, path);
}

/**
 * 处理API请求
 */
async function handleAPIRequest(request, path) {
  // 获取服务器列表
  if (path === "/api/servers" && request.method === "GET") {
    return handleGetServers();
  }
  // 获取所有服务器的最新状态
  if (path === "/api/servers/status" && request.method === "GET") {
    return handleGetAllServerStatus();
  }

  // 获取指定服务器的最新状态
  if (
    path.match(/^\/api\/servers\/[^\/]+\/status$/) &&
    request.method === "GET"
  ) {
    const serverId = path.split("/")[3];
    return handleGetServerStatus(serverId);
  }

  // 获取指定服务器的历史数据
  if (
    path.match(/^\/api\/servers\/[^\/]+\/history$/) &&
    request.method === "GET"
  ) {
    const serverId = path.split("/")[3];
    const url = new URL(request.url);
    const start = url.searchParams.get("start");
    const end = url.searchParams.get("end");
    return handleGetServerHistory(serverId, start, end);
  }

  // 未找到匹配的API路由
  return new Response("API not found", { status: 404 });
}

/**
 * 处理上报数据请求
 */
async function handleReportData(request) {
  // 验证认证
  const authHeader = request.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return new Response("Unauthorized", { status: 401 });
  }

  const token = authHeader.replace("Bearer ", "");
  if (token !== CONFIG.AUTH_KEY) {
    return new Response("Invalid authentication token", { status: 403 });
  }

  try {
    // 解析请求体
    const data = await request.json();

    // 验证数据格式
    if (!validateReportData(data)) {
      return new Response("Invalid data format", { status: 400 });
    }

    // 存储数据
    await storeServerData(data);

    // 返回成功响应
    return new Response(JSON.stringify({ success: true }), {
      headers: {
        "Content-Type": "application/json",
        ...CONFIG.CORS_HEADERS,
      },
    });
  } catch (error) {
    // 处理错误
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: {
        "Content-Type": "application/json",
        ...CONFIG.CORS_HEADERS,
      },
    });
  }
}

/**
 * 验证上报的数据格式
 */
function validateReportData(data) {
  // 检查必要字段
  if (!data.hostname || !data.server_id || !data.timestamp) {
    return false;
  }

  // 检查CPU数据
  if (!data.cpu || typeof data.cpu.usage_percent !== "number") {
    return false;
  }

  // 检查内存数据
  if (
    !data.memory ||
    typeof data.memory.total !== "number" ||
    typeof data.memory.used !== "number"
  ) {
    return false;
  }

  // 检查磁盘数据
  if (
    !data.disk ||
    typeof data.disk.total !== "number" ||
    typeof data.disk.used !== "number"
  ) {
    return false;
  }

  // 检查网络数据
  if (
    !data.network ||
    typeof data.network.rx_bytes !== "number" ||
    typeof data.network.tx_bytes !== "number"
  ) {
    return false;
  }

  return true;
}

/**
 * 获取最近的10分钟整点时间戳（毫秒级）
 * @param {number} timestamp - 原始毫秒时间戳
 * @returns {number} 最近的10分钟整点时间戳
 */
function getNearestTenMinutes(timestamp) {
    // 10分钟对应的毫秒数 (10 * 60 * 1000)
    const tenMinutes = 600000;
    // 向下取整到最近的10分钟
    return Math.floor(timestamp / tenMinutes) * tenMinutes;
}

/**
 * 存储服务器数据到KV
 */
async function storeServerData(data) {
  const serverId = data.server_id;
  const timestamp = data.timestamp * 1000; // 转换为毫秒
  const nearestTenMinutes = getNearestTenMinutes(timestamp);
  data.timestamp = timestamp/1000;

  // 获取储存状态
  const history = await SERVER_STATUS.get(`history:${serverId}:${nearestTenMinutes}`, {
    type: "json",
  });
  let newHistory = [];
  // 检查是否存在
  if (history) {
    newHistory.push(...history, data)
  } else {
    newHistory.push(data)
  }

  // 存储最新状态
  await SERVER_STATUS.put(`status:${serverId}`, JSON.stringify(data));

  // 存储历史数据
  await SERVER_STATUS.put(
    `history:${serverId}:${nearestTenMinutes}`,
    JSON.stringify(newHistory)
  );

  // 更新服务器列表
  await updateServersList(serverId, data.hostname, data.ip);
}

/**
 * 更新服务器列表
 */
async function updateServersList(serverId, hostname, ip) {
  // 获取当前服务器列表
  let serversList = [];
  try {
    const existingList = await SERVER_STATUS.get("servers_list", {
      type: "json",
    });
    if (existingList) {
      serversList = existingList;
    }
  } catch (error) {
    // 如果没有现有列表或解析错误, 使用空列表
    serversList = [];
  }

  // 检查服务器是否已在列表中
  const existingIndex = serversList.findIndex(
    (server) => server.id === serverId
  );
  const now = Date.now();

  if (existingIndex >= 0) {
    // 更新现有服务器信息
    serversList[existingIndex] = {
      id: serverId,
      hostname: hostname,
      ip: ip,
      last_seen: now,
    };
  } else {
    // 添加新服务器
    serversList.push({
      id: serverId,
      hostname: hostname,
      ip: ip,
      last_seen: now,
    });
  }

  // 存储更新后的列表
  await SERVER_STATUS.put("servers_list", JSON.stringify(serversList));
}

/**
 * 处理获取服务器列表请求
 */
async function handleGetServers() {
  try {
    // 获取服务器列表
    const serversList = await SERVER_STATUS.get("servers_list", {
      type: "json",
    });

    if (!serversList) {
      return new Response(JSON.stringify([]), {
        headers: {
          "Content-Type": "application/json",
          ...CONFIG.CORS_HEADERS,
        },
      });
    }

    return new Response(JSON.stringify(serversList), {
      headers: {
        "Content-Type": "application/json",
        ...CONFIG.CORS_HEADERS,
      },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: {
        "Content-Type": "application/json",
        ...CONFIG.CORS_HEADERS,
      },
    });
  }
}

/**
 * 处理获取所有服务器最新状态
 */
async function handleGetAllServerStatus() {
  try {
    // 获取服务器列表
    const serversList = await SERVER_STATUS.get("servers_list", {
      type: "json",
    });

    if (!serversList) {
      return new Response(JSON.stringify([]), {
        headers: {
          "Content-Type": "application/json",
          ...CONFIG.CORS_HEADERS,
        },
      });
    }

    let statusList = [];

    for(const server of serversList){
      // 获取服务器最新状态
      const status = await SERVER_STATUS.get(`status:${server.id}`, {
        type: "json",
      });

      if (status) {
        statusList.push(status);
      }
    }

    return new Response(JSON.stringify(statusList), {
      headers: {
        "Content-Type": "application/json",
        ...CONFIG.CORS_HEADERS,
      },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: {
        "Content-Type": "application/json",
        ...CONFIG.CORS_HEADERS,
      },
    });
  }
}

/**
 * 处理获取服务器状态请求
 */
async function handleGetServerStatus(serverId) {
  try {
    // 获取服务器最新状态
    const status = await SERVER_STATUS.get(`status:${serverId}`, {
      type: "json",
    });

    if (!status) {
      return new Response(JSON.stringify({ error: "Server not found" }), {
        status: 404,
        headers: {
          "Content-Type": "application/json",
          ...CONFIG.CORS_HEADERS,
        },
      });
    }

    return new Response(JSON.stringify(status), {
      headers: {
        "Content-Type": "application/json",
        ...CONFIG.CORS_HEADERS,
      },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: {
        "Content-Type": "application/json",
        ...CONFIG.CORS_HEADERS,
      },
    });
  }
}

/**
 * 处理获取服务器历史数据请求
 */
async function handleGetServerHistory(serverId, startParam, endParam) {
  try {
    // 解析时间范围参数
    const now = Date.now();
    const end = endParam ? parseInt(endParam) : now;
    const start = startParam ? parseInt(startParam) : end - 24 * 60 * 60 * 1000; // 默认24小时

    // 列出指定时间范围内的历史数据
    const prefix = `history:${serverId}:`;
    const options = {
      prefix: prefix,
      start: `${prefix}${start}`,
      end: `${prefix}${end + 1}`, // 加1确保包含end时间戳
    };

    const listResult = await SERVER_STATUS.list(options);

    // 如果没有数据, 返回空数组
    if (!listResult.keys || listResult.keys.length === 0) {
      return new Response(JSON.stringify([]), {
        headers: {
          "Content-Type": "application/json",
          ...CONFIG.CORS_HEADERS,
        },
      });
    }

    // 获取所有历史数据
    const historyPromises = listResult.keys.map(async (key) => {
      const data = await SERVER_STATUS.get(key.name, { type: "json" });
      return data;
    });

    const historyArrays = await Promise.all(historyPromises);

    // 将二维数组扁平化为一维数组
    const historyData = historyArrays.flat(); 

    // 按时间戳排序
    historyData.sort((a, b) => a.timestamp - b.timestamp);

    return new Response(JSON.stringify(historyData), {
      headers: {
        "Content-Type": "application/json",
        ...CONFIG.CORS_HEADERS,
      },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: {
        "Content-Type": "application/json",
        ...CONFIG.CORS_HEADERS,
      },
    });
  }
}

/**
 * 处理静态资源请求
 */
async function handleStaticAsset(request, path) {
  // 默认返回404
  return new Response("Not Found", { status: 404 });
}

/**
 * 处理CORS预检请求
 */
function handleCORS() {
  return new Response(null, {
    headers: CONFIG.CORS_HEADERS,
  });
}

/**
 * 根据文件扩展名获取Content-Type
 */
function getContentType(path) {
  const extension = path.split(".").pop().toLowerCase();
  const contentTypes = {
    html: "text/html",
    css: "text/css",
    js: "application/javascript",
    json: "application/json",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    svg: "image/svg+xml",
    ico: "image/x-icon",
  };

  return contentTypes[extension] || "text/plain";
}

// 注册事件监听器
addEventListener("fetch", (event) => {
  event.respondWith(handleRequest(event.request));
});

// 定期清理过期数据
addEventListener("scheduled", (event) => {
  event.waitUntil(cleanupExpiredData());
});

/**
 * 清理过期数据
 */
async function cleanupExpiredData() {
  const now = Date.now();
  const cutoffTime = now - CONFIG.DATA_RETENTION_MS;

  // 获取服务器列表
  const serversList = await SERVER_STATUS.get("servers_list", { type: "json" });

  if (!serversList) {
    return;
  }

  // 遍历每个服务器, 清理过期数据
  for (const server of serversList) {
    const serverId = server.id;
    const prefix = `history:${serverId}:`;

    // 列出所有历史数据
    const listResult = await SERVER_STATUS.list({ prefix });

    // 删除过期数据
    for (const key of listResult.keys) {
      const timestamp = parseInt(key.name.replace(prefix, ""));
      if (timestamp < cutoffTime) {
        await SERVER_STATUS.delete(key.name);
      }
    }
  }
}
