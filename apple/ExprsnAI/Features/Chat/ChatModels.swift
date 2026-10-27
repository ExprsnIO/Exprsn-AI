import Foundation

struct ChatProfile: Decodable, Identifiable, Hashable, Sendable {
    var id: String
    var name: String
    var displayName: String?
    var description: String?
    var model: String?
    var label: String?
    var thinkDefault: ThinkLevel?
    var thinkCeiling: ThinkLevel?
    var tools: [String]?
    var vision: Bool?
    var residency: String?
    var deprecated: Bool?
    var hidden: Bool?
    var `default`: Bool?
    var title: String { displayName ?? name }
    /// The thinking levels this profile allows, up to its ceiling.
    var thinkLevels: [ThinkLevel] { ThinkLevel.allCases.filter { $0.rank <= (thinkCeiling ?? .off).rank } }
}

/// Thinking effort, as profiles carry it since 1.6.0 (`off`, `low`, `medium`, `high`); older servers sent booleans.
enum ThinkLevel: String, Codable, CaseIterable, Identifiable, Sendable {
    case off, low, medium, high
    var id: String { rawValue }
    var rank: Int { Self.allCases.firstIndex(of: self)! }
    var title: String { rawValue.capitalized }
    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let b = try? c.decode(Bool.self) { self = b ? .medium : .off; return }
        let s = try c.decode(String.self)
        self = ThinkLevel(rawValue: s) ?? .off
    }
}

struct ConversationSummary: Decodable, Identifiable, Hashable, Sendable {
    var id: String
    var kind: String?
    var title: String?
    var label: String?
    var profileId: String?
    var workspaceId: String?
    var folderId: String?
    var updatedAt: Double?
    var createdAt: Double?
    var archived: Bool?
    var updated: Date? { updatedAt.map { Date(timeIntervalSince1970: $0 / 1000) } }
}

struct ChatFolder: Decodable, Identifiable, Hashable, Sendable {
    var id: String; var name: String; var parentId: String?; var depth: Int?; var conversations: Int?
}

/// One message of a conversation tree, as `GET /conversations/:id` returns it.
struct ChatMessage: Identifiable, Hashable, Sendable {
    var id: String
    var parentId: String?
    var role: String
    var content: String
    var thinking: String?
    var state: String
    var seq: Int
    var profile: String?
    var model: String?
    var think: String?
    var compareSlot: Int?
    var error: String?
    var label: String?
    var usage: JSONValue
    var tools: [JSONValue]
    var citations: [JSONValue]
    var guardInfo: JSONValue
    var attachments: [JSONValue]
    var createdAt: Date?
    var completedAt: Date?

    init(_ v: JSONValue) {
        id = v["id"].text
        parentId = v["parentId"].string
        role = v["role"].string ?? "assistant"
        content = v["content"].string ?? ""
        thinking = v["thinking"].string
        state = v["state"].string ?? "complete"
        seq = v["seq"].int ?? 0
        profile = v["profile"].string
        model = v["model"].string
        think = v["think"].string
        compareSlot = v["compareSlot"].int
        error = v["error"].string
        label = v["label"].string
        usage = v["usage"]
        tools = v["tools"].array
        citations = v["citations"].array
        guardInfo = v["guard"]
        attachments = v["attachments"].array
        createdAt = v["createdAt"].date
        completedAt = v["completedAt"].date
    }

    var isGenerating: Bool { state == "queued" || state == "streaming" }
}

struct ConversationDetail: Sendable {
    var id: String
    var title: String
    var label: String
    var kind: String
    var headId: String?
    var messages: [ChatMessage]

    init(_ v: JSONValue) {
        id = v["id"].text; title = v["title"].string ?? "Untitled"; label = v["label"].string ?? "internal"; kind = v["kind"].string ?? "chat"
        headId = v["headId"].string
        messages = v["messages"].array.map(ChatMessage.init)
    }

    /// The active branch: from the head up to the root, then reversed.
    var activeBranch: [ChatMessage] {
        let byId = Dictionary(messages.map { ($0.id, $0) }, uniquingKeysWith: { $1 })
        var out: [ChatMessage] = []
        var cur = headId.flatMap { byId[$0] } ?? messages.max { $0.seq < $1.seq }
        var guardCount = 0
        while let m = cur, guardCount < 10_000 {
            out.append(m); guardCount += 1
            cur = m.parentId.flatMap { byId[$0] }
        }
        return out.reversed()
    }

    /// Sibling answers (regenerations) of a message: other children of its parent with the same role.
    func siblings(of m: ChatMessage) -> [ChatMessage] {
        messages.filter { $0.parentId == m.parentId && $0.role == m.role }.sorted { ($0.createdAt ?? .distantPast) < ($1.createdAt ?? .distantPast) }
    }
}
