import Foundation

/// RFC 9457 problem details, as every Exprsn-AI route fails.
struct APIProblem: Error, LocalizedError, Sendable {
    var status: Int
    var title: String
    var detail: String?
    var traceId: String?
    var extensions: [String: JSONValue] = [:]
    var retryAfterSeconds: Int?

    var errorDescription: String? { detail.map { "\(title). \($0)" } ?? title }
    var step: String? { extensions["step"]?.string }
    var stepUpRequired: Bool { extensions["step_up"]?.bool == true || title == "Step-up required" }
    var stage: String? { extensions["stage"]?.string }

    static func transport(_ error: Error) -> APIProblem {
        APIProblem(status: 0, title: "Could not reach the server", detail: error.localizedDescription)
    }
    static func decoding(_ error: Error) -> APIProblem {
        APIProblem(status: 0, title: "Unexpected answer", detail: String(describing: error))
    }
}

enum HTTPMethod: String, Sendable { case get = "GET", post = "POST", put = "PUT", patch = "PATCH", delete = "DELETE" }

/// How a client proves who it is. Cookie sessions also carry the CSRF token on unsafe methods; API keys travel as
/// `Authorization: Bearer exai_k1_…`; OpenAI-compatible platforms take a plain bearer key.
enum Credential: Sendable, Equatable {
    case none
    case session(csrf: String)
    case apiKey(String)
    case bearer(String)
}

/// One HTTP client per server profile. Each has its own cookie jar so two servers never share a session.
final class APIClient: @unchecked Sendable {
    let baseURL: URL
    private let session: URLSession
    private let lock = NSLock()
    private var _credential: Credential = .none
    private var _workspaceId: String?
    private var _dataLabel: String?
    /// The session cookies, kept by name and sent as one `Cookie` header (URLSession's own jar is bypassed so two
    /// servers never share a session and the jar can be saved to the Keychain).
    private var _cookies: [String: String] = [:]

    var credential: Credential {
        get { lock.withLock { _credential } }
        set { lock.withLock { _credential = newValue } }
    }
    var workspaceId: String? {
        get { lock.withLock { _workspaceId } }
        set { lock.withLock { _workspaceId = newValue } }
    }
    /// The `X-Data-Label` for `/v1` calls.
    var dataLabel: String? {
        get { lock.withLock { _dataLabel } }
        set { lock.withLock { _dataLabel = newValue } }
    }

    init(baseURL: URL) {
        self.baseURL = baseURL
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil
        config.httpCookieAcceptPolicy = .never
        config.httpShouldSetCookies = false
        config.timeoutIntervalForRequest = 60
        config.timeoutIntervalForResource = 600
        config.waitsForConnectivity = true
        self.session = URLSession(configuration: config)
    }

    // MARK: Cookies (persisted to the Keychain by the session store)

    var cookies: [[String: String]] { lock.withLock { _cookies.map { ["name": $0.key, "value": $0.value] } } }

    func restoreCookies(_ pairs: [[String: String]]) {
        lock.withLock { for p in pairs { if let n = p["name"], let v = p["value"] { _cookies[n] = v } } }
    }

    func clearCookies() { lock.withLock { _cookies = [:] } }

    private func absorbCookies(from response: HTTPURLResponse) {
        guard let fields = response.allHeaderFields as? [String: String] else { return }
        let set = HTTPCookie.cookies(withResponseHeaderFields: fields, for: baseURL)
        guard !set.isEmpty else { return }
        lock.withLock {
            for c in set {
                if let exp = c.expiresDate, exp < Date() { _cookies.removeValue(forKey: c.name) } else { _cookies[c.name] = c.value }
            }
        }
    }

    // MARK: URLs

    /// `api("me")` → `<base>/api/me`. A path starting with `/` is used as is (`/v1/models`, `/mcp/...`).
    func url(_ path: String, query: [String: String?] = [:]) -> URL {
        let joined = path.hasPrefix("/") ? path : "/api/" + path
        var comps = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)!
        let basePath = comps.path.hasSuffix("/") ? String(comps.path.dropLast()) : comps.path
        comps.path = basePath + joined
        let items = query.compactMap { k, v in v.map { URLQueryItem(name: k, value: $0) } }
        comps.queryItems = items.isEmpty ? nil : items.sorted { $0.name < $1.name }
        return comps.url!
    }

    func makeRequest(_ method: HTTPMethod, _ path: String, query: [String: String?] = [:], body: Data? = nil, contentType: String = "application/json", headers: [String: String] = [:]) -> URLRequest {
        var req = URLRequest(url: url(path, query: query))
        req.httpMethod = method.rawValue
        req.setValue("application/json, application/problem+json", forHTTPHeaderField: "Accept")
        req.setValue("ExprsnAI-Apple/1.0", forHTTPHeaderField: "User-Agent")
        switch credential {
        case .none: break
        case .session(let csrf):
            if method != .get { req.setValue(csrf, forHTTPHeaderField: "X-CSRF-Token") }
        case .apiKey(let key), .bearer(let key):
            req.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        }
        if let ws = workspaceId, !ws.isEmpty { req.setValue(ws, forHTTPHeaderField: "X-Workspace") }
        let jar = lock.withLock { _cookies }
        if !jar.isEmpty { req.setValue(jar.map { "\($0.key)=\($0.value)" }.joined(separator: "; "), forHTTPHeaderField: "Cookie") }
        if let label = dataLabel, path.hasPrefix("/v1") { req.setValue(label, forHTTPHeaderField: "X-Data-Label") }
        if let body {
            req.httpBody = body
            req.setValue(contentType, forHTTPHeaderField: "Content-Type")
        }
        for (k, v) in headers { req.setValue(v, forHTTPHeaderField: k) }
        return req
    }

    // MARK: Requests

    @discardableResult
    func send(_ method: HTTPMethod, _ path: String, query: [String: String?] = [:], body: JSONValue? = nil, raw: Data? = nil, contentType: String = "application/json", headers: [String: String] = [:]) async throws -> (Data, HTTPURLResponse) {
        let data = raw ?? body?.data
        let req = makeRequest(method, path, query: query, body: data, contentType: raw != nil ? contentType : "application/json", headers: headers)
        let (out, resp): (Data, URLResponse)
        do { (out, resp) = try await session.data(for: req) } catch { throw APIProblem.transport(error) }
        let http = resp as! HTTPURLResponse
        absorbCookies(from: http)
        guard (200..<300).contains(http.statusCode) else { throw Self.problem(from: out, response: http) }
        return (out, http)
    }

    func json(_ method: HTTPMethod, _ path: String, query: [String: String?] = [:], body: JSONValue? = nil) async throws -> JSONValue {
        let (data, _) = try await send(method, path, query: query, body: body)
        if data.isEmpty { return .null }
        do { return try JSONDecoder().decode(JSONValue.self, from: data) } catch { throw APIProblem.decoding(error) }
    }

    func decode<T: Decodable>(_ method: HTTPMethod, _ path: String, query: [String: String?] = [:], body: JSONValue? = nil, as type: T.Type = T.self) async throws -> T {
        let (data, _) = try await send(method, path, query: query, body: body)
        do { return try JSONDecoder.api.decode(T.self, from: data) } catch { throw APIProblem.decoding(error) }
    }

    func get(_ path: String, query: [String: String?] = [:]) async throws -> JSONValue { try await json(.get, path, query: query) }
    func post(_ path: String, _ body: JSONValue? = nil, query: [String: String?] = [:]) async throws -> JSONValue { try await json(.post, path, query: query, body: body) }
    func put(_ path: String, _ body: JSONValue? = nil, query: [String: String?] = [:]) async throws -> JSONValue { try await json(.put, path, query: query, body: body) }
    func patch(_ path: String, _ body: JSONValue? = nil) async throws -> JSONValue { try await json(.patch, path, body: body) }
    func delete(_ path: String, _ body: JSONValue? = nil) async throws -> JSONValue { try await json(.delete, path, body: body) }

    /// Uploads a file as the raw request body (`PUT /attachments`, `PUT /files/uploads`, knowledge uploads).
    func upload(_ path: String, data: Data, contentType: String, query: [String: String?]) async throws -> JSONValue {
        let (out, _) = try await send(.put, path, query: query, raw: data, contentType: contentType)
        return out.isEmpty ? .null : ((try? JSONDecoder().decode(JSONValue.self, from: out)) ?? .null)
    }

    /// Downloads bytes with their content type and suggested file name.
    func download(_ path: String, query: [String: String?] = [:]) async throws -> (Data, String, String?) {
        let (data, resp) = try await send(.get, path, query: query)
        let type = resp.value(forHTTPHeaderField: "Content-Type") ?? "application/octet-stream"
        var name: String?
        if let cd = resp.value(forHTTPHeaderField: "Content-Disposition"), let r = cd.range(of: "filename=\"") {
            name = String(cd[r.upperBound...].prefix(while: { $0 != "\"" }))
        }
        return (data, type, name)
    }

    /// A streaming request whose body arrives line by line (server-sent events or NDJSON).
    func lines(_ method: HTTPMethod, _ path: String, body: JSONValue?, accept: String = "text/event-stream") async throws -> (URLSession.AsyncBytes, HTTPURLResponse) {
        var req = makeRequest(method, path, body: body?.data)
        req.setValue(accept, forHTTPHeaderField: "Accept")
        let (bytes, resp): (URLSession.AsyncBytes, URLResponse)
        do { (bytes, resp) = try await session.bytes(for: req) } catch { throw APIProblem.transport(error) }
        let http = resp as! HTTPURLResponse
        absorbCookies(from: http)
        guard (200..<300).contains(http.statusCode) else {
            var data = Data()
            for try await b in bytes { data.append(b) }
            throw Self.problem(from: data, response: http)
        }
        return (bytes, http)
    }

    static func problem(from data: Data, response: HTTPURLResponse) -> APIProblem {
        var p = APIProblem(status: response.statusCode, title: HTTPURLResponse.localizedString(forStatusCode: response.statusCode).capitalized)
        p.retryAfterSeconds = response.value(forHTTPHeaderField: "Retry-After").flatMap { Int($0) }
        if let v = try? JSONDecoder().decode(JSONValue.self, from: data) {
            if let err = v["error"].object["message"]?.string {
                // OpenAI-shaped errors on /v1
                p.title = v["error"]["type"].string ?? p.title
                p.detail = err
                p.extensions = v["error"].object
            } else {
                p.title = v["title"].string ?? p.title
                p.detail = v["detail"].string
                p.traceId = v["trace_id"].string ?? v["traceId"].string
                var ext = v.object
                for k in ["type", "title", "status", "detail", "instance", "trace_id"] { ext.removeValue(forKey: k) }
                p.extensions = ext
            }
        } else if let text = String(data: data, encoding: .utf8), !text.isEmpty, text.count < 400 {
            p.detail = text
        }
        return p
    }
}

extension JSONDecoder {
    /// Tolerant of the API's epoch-millisecond timestamps.
    static let api: JSONDecoder = {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .custom { decoder in
            let c = try decoder.singleValueContainer()
            if let n = try? c.decode(Double.self) { return JSONValue.number(n).date ?? Date(timeIntervalSince1970: 0) }
            if let s = try? c.decode(String.self), let d = JSONValue.string(s).date { return d }
            throw DecodingError.dataCorruptedError(in: c, debugDescription: "Not a date")
        }
        return d
    }()
}
