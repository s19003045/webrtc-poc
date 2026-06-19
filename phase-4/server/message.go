package main

import "encoding/json"

// 與 Phase 2/3 完全相同的信令協議，這裡用 Go struct 強型別化。
//
// 重點：Data 用 json.RawMessage，伺服器「不解讀」SDP / ICE candidate 的內容，
// 只原封不動轉發 —— 跟前面 Node 版的行為一致，伺服器完全不懂 WebRTC。

// Inbound：client → server
type Inbound struct {
	Type string          `json:"type"`           // "join" | "signal"
	Room string          `json:"room,omitempty"` // join 用
	To   string          `json:"to,omitempty"`   // signal 的收件 peer id
	Data json.RawMessage `json:"data,omitempty"` // signal 的內容（sdp / candidate）
}

// Joined：回給新加入者的訊息，獨立成一個 struct。
// 關鍵：Peers「不用」omitempty —— 前端在 joined 時必定要拿到陣列（含空陣列）。
// 若省略，空房時欄位會消失，前端對 undefined 迭代就會出錯。
type Joined struct {
	Type  string   `json:"type"`  // 恆為 "joined"
	ID    string   `json:"id"`    // 新加入者自己的 peer id
	Peers []string `json:"peers"` // 房內既有成員（可能為空陣列）
}

// Outbound：其餘 server → client 訊息（peer-joined | signal | peer-left | full）。
// 這些都用 omitempty 保持精簡，尤其 signal（ICE candidate）非常頻繁。
type Outbound struct {
	Type string          `json:"type"`
	ID   string          `json:"id,omitempty"`   // peer-joined / peer-left 的 peer id
	From string          `json:"from,omitempty"` // signal 的寄件 peer id
	Data json.RawMessage `json:"data,omitempty"` // signal 的內容
}
