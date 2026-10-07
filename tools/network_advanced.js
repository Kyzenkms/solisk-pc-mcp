const { execPowershellAsync } = require("../lib/powershell");
const axios = require("axios");

const advancedNetworkTools = [
  {
    name: "ping_host",
    description: "Ping a host and return latency and packet loss statistics.",
    inputSchema: {
      type: "object",
      properties: {
        host: { type: "string", description: "Hostname or IP to ping (e.g. 'google.com' or '8.8.8.8')" },
        count: { type: "number", description: "Number of pings (default: 4)", default: 4 },
        timeout_ms: { type: "number", description: "Timeout in milliseconds (default: 10000)", default: 10000 },
      },
      required: ["host"],
    },
    handler: async ({ host, count = 4, timeout_ms = 10000 }) => {
      const res = await execPowershellAsync(`Test-Connection -ComputerName '${host}' -Count ${count} -ErrorAction SilentlyContinue | Select-Object Address,Latency,ResponseTime,StatusCode | ConvertTo-Json -Depth 2`, { timeout: timeout_ms });
      if (res.status === 0 && res.stdout) {
        try {
          let data = JSON.parse(res.stdout);
          if (!Array.isArray(data)) data = [data];
          const latencies = data
            .map((d) => (d.Latency !== undefined && d.Latency !== null) ? d.Latency : ((d.ResponseTime !== undefined && d.ResponseTime !== null) ? d.ResponseTime : null))
            .filter((l) => l !== null && l !== undefined && !isNaN(Number(l)))
            .map(Number);
          return {
            success: true,
            data: {
              host,
              count,
              results: data,
              avg_latency_ms: latencies.length ? (latencies.reduce((a, b) => a + b, 0) / latencies.length).toFixed(1) : null,
              min_latency_ms: latencies.length ? Math.min(...latencies) : null,
              max_latency_ms: latencies.length ? Math.max(...latencies) : null,
              reachable: data.some((d) => d.StatusCode === 0 || d.StatusCode === "Success" || d.StatusCode === undefined),
            }
          };
        } catch (e) {
          return { success: false, error: "Failed to parse connection test results", code: "PARSE_ERROR" };
        }
      }
      return { success: true, data: { host, reachable: false, error: res.stderr || res.error } };
    },
  },
  {
    name: "get_public_ip",
    description: "Get the public (external) IP address of this machine.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      try {
        const response = await axios.get("https://api.ipify.org?format=json", { timeout: 8000 });
        const ip = response.data.ip;
        let geoData = {};
        try {
          const geo = await axios.get(`https://ipapi.co/${ip}/json/`, { timeout: 5000 });
          geoData = {
            country: geo.data.country_name,
            region: geo.data.region,
            city: geo.data.city,
            isp: geo.data.org,
            timezone: geo.data.timezone,
          };
        } catch (e) {}
        return {
          success: true,
          data: { ip, ...geoData }
        };
      } catch (err) {
        const code = err.code || "";
        const msg = err.message || "";
        if (
          code === "ENOTFOUND" ||
          code === "EAI_AGAIN" ||
          code === "ENETUNREACH" ||
          code === "ECONNREFUSED" ||
          code === "ETIMEDOUT" ||
          /getaddrinfo|network|internet|offline|disconnected|unreachable/i.test(msg)
        ) {
          return {
            success: false,
            error: "No internet connection or host unreachable. Please verify your network connection and try again.",
            technical_details: msg || code,
            code: "NO_INTERNET",
          };
        }
        return { success: false, error: `IP lookup failed: ${err.message}`, code: "IP_LOOKUP_FAILED" };
      }
    },
  },
  {
    name: "get_local_ip",
    description: "Get the local network IP address and network adapter information.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      const res = await execPowershellAsync(
        `Get-NetIPAddress -AddressFamily IPv4 | Where-Object {$_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*'} | Select-Object InterfaceAlias,IPAddress,PrefixLength | ConvertTo-Json -Depth 2`
      );
      if (res.status === 0 && res.stdout) {
        try {
          let adapters = JSON.parse(res.stdout);
          if (!Array.isArray(adapters)) adapters = [adapters];
          return { success: true, data: { adapters } };
        } catch (e) {
          return { success: false, error: "Failed to parse local network adapters", code: "PARSE_ERROR" };
        }
      }
      return { success: false, error: res.stderr || res.error || "Failed to get local IP", code: "GET_LOCAL_IP_FAILED" };
    },
  },
  {
    name: "list_network_connections",
    description: "List active network connections and listening ports.",
    inputSchema: {
      type: "object",
      properties: {
        filter: { type: "string", description: "Filter by state: LISTEN, ESTABLISHED, all (default: all)", default: "all" },
        limit: { type: "number", description: "Maximum connections to return (default: 50)", default: 50 },
        timeout_ms: { type: "number", description: "Timeout in milliseconds (default: 10000)", default: 10000 },
      },
    },
    handler: async ({ filter = "all", limit = 50, timeout_ms = 10000 }) => {
      const stateFilter = filter === "all" ? "" : `| Where-Object {$_.State -eq '${filter}'}`;
      const res = await execPowershellAsync(
        `Get-NetTCPConnection ${stateFilter} -ErrorAction SilentlyContinue | Select-Object -First ${limit} LocalAddress,LocalPort,RemoteAddress,RemotePort,State | Sort-Object State | ConvertTo-Json -Depth 2`,
        { timeout_ms }
      );
      if (res.status === 0 && res.stdout) {
        try {
          let connections = JSON.parse(res.stdout);
          if (!Array.isArray(connections)) connections = [connections];
          return { success: true, data: { count: connections.length, connections } };
        } catch (e) {
          return { success: true, data: { count: 0, connections: [] } };
        }
      }
      return { success: false, error: res.stderr || res.error || "Failed to get network connections", code: "GET_CONNECTIONS_FAILED" };
    },
  },
  {
    name: "dns_lookup",
    description: "Perform a DNS lookup for a domain name.",
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "string", description: "Domain name to look up" },
      },
      required: ["domain"],
    },
    handler: async ({ domain }) => {
      const res = await execPowershellAsync(
        `Resolve-DnsName '${domain}' -ErrorAction SilentlyContinue | Select-Object Name,Type,IPAddress,NameHost | ConvertTo-Json -Depth 2`
      );
      if (res.status === 0 && res.stdout) {
        try {
          let records = JSON.parse(res.stdout);
          if (!Array.isArray(records)) records = [records];
          return { success: true, data: { domain, records } };
        } catch (e) {
          return { success: false, error: "Failed to parse DNS response", code: "PARSE_ERROR" };
        }
      }
      const errDetail = res.stderr || res.error || "";
      const isUnreachable = /DNS name does not exist|Resolve-DnsName :|Win32Exception|No such host|timed? out/i.test(errDetail);
      return {
        success: false,
        error: isUnreachable
          ? `DNS lookup failed for "${domain}". The domain does not exist or your internet connection is unavailable.`
          : `DNS lookup failed for ${domain}: ${errDetail || "Unknown error"}`,
        code: "DNS_LOOKUP_FAILED",
        technical_details: errDetail,
      };
    },
  },
  {
    name: "list_wifi_networks",
    description: "List available WiFi networks nearby.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      const res = await execPowershellAsync(`netsh wlan show networks mode=bssid | Select-String -Pattern 'SSID|Signal|Authentication'`);
      if (res.status === 0) {
        return { success: true, data: { output: res.stdout } };
      }
      return { success: false, error: res.stderr || res.error || "Failed to scan networks", code: "WIFI_SCAN_FAILED" };
    },
  },
  {
    name: "get_wifi_password",
    description: "Get the saved WiFi password for a known network (SSID). (Requires confirmation).",
    inputSchema: {
      type: "object",
      properties: {
        network_name: { type: "string", description: "WiFi network SSID name" },
        confirm: { type: "boolean", description: "Must set to true to execute", default: false }
      },
      required: ["network_name"],
    },
    handler: async ({ network_name, confirm }) => {
      if (!confirm) {
        return {
          success: false,
          error: "Retrieving WiFi passwords is a sensitive credential exposure action. You must pass 'confirm: true' to perform this action.",
          code: "CONFIRMATION_REQUIRED"
        };
      }
      const res = await execPowershellAsync(`netsh wlan show profile name='${network_name}' key=clear | Select-String 'Key Content'`);
      if (res.status === 0 && res.stdout) {
        const match = res.stdout.match(/Key Content\s*:\s*(.+)/);
        if (match) {
          return { success: true, data: { network: network_name, password: match[1].trim() } };
        }
      }
      return { success: false, error: "Password not found or access denied", code: "PASSWORD_NOT_FOUND" };
    },
  },
];

module.exports = advancedNetworkTools;
