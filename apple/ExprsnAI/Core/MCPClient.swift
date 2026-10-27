import Foundation

/// A Model Context Protocol client over Streamable HTTP (JSON-RPC 2.0, protocol 2025-06-18): initialize,
/// tools/list, tools/call, resources/list, prompts/list. Enough to inspect a server and call its tools by hand.
final class MCPClient: @unchecked Sendable {
    let url: URL
    let token: String?
    private var sessionId: String?
    private var nextId = 1
    private let session: URLSession = {
        let c = URLSessionConfiguration.ephemeral; c.timeoutIntervalForRequest = 60; return URLSession(configuration: c)
    }()

    struct Tool: Identifiable, Hashable { var name: String; var title: String?; var description: String?; var inputSchema: JSONValue; var annotations: JSONValue; var id: String { name } }
    struct InitResult { var protocolVersion: String; var serverInfo: JSONValue; var capabilities: JSONValue; var instructions: String? }

    init(url: URL, token: String?) { self.url = url; self.token = token }

    private func rpc(_ method: String, params: JSONValue = .object([:]), notification: Bool = false) async throws -> JSONValue {
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("application/json, text/event-stream", forHTTPHeaderField: "Accept")
        req.setValue("2025-06-18", forHTTPHeaderField: "MCP-Protocol-Version")
        if let token, !token.isEmpty { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let sessionId { req.setValue(sessionId, forHTTPHeaderField: "Mcp-Session-Id") }
        var body: [String: JSONValue] = ["jsonrpc": "2.0", "method": .string(method), "params": params]
        let id = nextId; nextId += 1
        if !notification { body["id"] = .number(Double(id)) }
        req.httpBody = JSONValue.object(body).data
        let (data, resp) = try await session.data(for: req)
        let http = resp as! HTTPURLResponse
        if let sid = http.value(forHTTPHeaderField: "Mcp-Session-Id") { sessionId = sid }
        guard (200..<300).contains(http.statusCode) else { throw APIClient.problem(from: data, response: http) }
        if notification { return .null }
        let type = http.value(forHTTPHeaderField: "Content-Type") ?? ""
        var message: JSONValue = .null
        if type.contains("text/event-stream") {
            // The answer comes as events; take the one carrying our id.
            for block in String(decoding: data, as: UTF8.self).components(separatedBy: "\n\n") {
                let payload = block.components(separatedBy: "\n").filter { $0.hasPrefix("data:") }.map { $0.dropFirst(5).trimmingCharacters(in: .whitespaces) }.joined(separator: "\n")
                if let d = payload.data(using: .utf8), let v = try? JSONDecoder().decode(JSONValue.self, from: d), v["id"].int == id { message = v }
            }
        } else {
            message = (try? JSONDecoder().decode(JSONValue.self, from: data)) ?? .null
        }
        if let err = message["error"].object["message"]?.string {
            throw APIProblem(status: 0, title: "MCP error \(message["error"]["code"].text)", detail: err)
        }
        return message["result"]
    }

    func initialize() async throws -> InitResult {
        let r = try await rpc("initialize", params: ["protocolVersion": "2025-06-18", "capabilities": [:], "clientInfo": ["name": "Exprsn-AI for Apple", "version": "1.0.0"]])
        _ = try? await rpc("notifications/initialized", notification: true)
        return InitResult(protocolVersion: r["protocolVersion"].text, serverInfo: r["serverInfo"], capabilities: r["capabilities"], instructions: r["instructions"].string)
    }

    func listTools() async throws -> [Tool] {
        var out: [Tool] = []
        var cursor: String? = nil
        repeat {
            let r = try await rpc("tools/list", params: cursor.map { ["cursor": .string($0)] } ?? [:])
            out += r["tools"].array.map { Tool(name: $0["name"].text, title: $0["title"].string, description: $0["description"].string, inputSchema: $0["inputSchema"], annotations: $0["annotations"]) }
            cursor = r["nextCursor"].string
        } while cursor != nil
        return out
    }

    func callTool(_ name: String, arguments: JSONValue) async throws -> JSONValue {
        try await rpc("tools/call", params: ["name": .string(name), "arguments": arguments])
    }

    func listResources() async throws -> [JSONValue] { try await rpc("resources/list")["resources"].array }
    func listPrompts() async throws -> [JSONValue] { try await rpc("prompts/list")["prompts"].array }
}
