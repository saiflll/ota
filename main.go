package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	mqtt "github.com/eclipse/paho.mqtt.golang"
	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/template/html/v2"
)

type NodeInfo struct {
	Status       string   `json:"status,omitempty"`
	RamFreeBytes int64    `json:"ram_free_bytes,omitempty"`
	SD_OK        *bool    `json:"sd_ok,omitempty"` // Use pointer to distinguish between false and not set
	Ck           string   `json:"ck,omitempty"`
	Area         string   `json:"area,omitempty"`
	No           string   `json:"no,omitempty"`
	Updated      string   `json:"updated,omitempty"`
	Logs         []string `json:"logs,omitempty"` // last 3 log lines
}

type FileInfo struct {
	Name       string    `json:"name"`
	URL        string    `json:"url"`
	UploadTime time.Time `json:"upload_time"`
}

var (
	mqttClient mqtt.Client
	nodeMutex  sync.RWMutex
	nodeStatus = make(map[string]*NodeInfo)
	fileMutex  sync.RWMutex
	fileInfos  = make(map[string]FileInfo)
)
var macRegex = regexp.MustCompile(`[0-9a-fA-F]{12}`)

// env helper
func getEnv(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func main() {
	// ensure upload dir
	if err := os.MkdirAll("static/uploads", 0755); err != nil {
		log.Fatalf("failed to create upload directory: %v", err)
	}

	// Load existing files on startup
	loadInitialFiles("static/uploads")
	engine := html.New("./views", ".html")
	app := fiber.New(fiber.Config{
		Views: engine,
	})

	// static assets & files
	app.Static("/static", "./static")
	app.Static("/files", "./static/uploads")

	// index
	app.Get("/", func(c *fiber.Ctx) error {
		brokerHost := getEnv("MQTT_BROKER", "tcp://172.20.100.11:1883")
		return c.Render("index", fiber.Map{
			"broker": brokerHost,
		})
	})

	// API: nodes snapshot
	app.Get("/api/nodes", func(c *fiber.Ctx) error {
		nodeMutex.RLock()
		defer nodeMutex.RUnlock()

		// Deduplication logic: only show the latest entry for each MAC address.
		// Assumes MAC is the last part of the node ID.
		latestNodes := make(map[string]*NodeInfo)
		macToNodeID := make(map[string]string)

		// Step 1: Find the latest node ID for each MAC address
		for id, info := range nodeStatus {
			matches := macRegex.FindAllString(id, -1)
			mac := id
			if len(matches) > 0 {
				mac = matches[len(matches)-1]
			}

			existingNodeID, found := macToNodeID[mac]
			if !found {
				macToNodeID[mac] = id
			} else if info.Updated > nodeStatus[existingNodeID].Updated {
				// This node is newer than the one we previously recorded for this MAC.
				// Update our record to point to this newer node ID.
				macToNodeID[mac] = id
			}
		}

		// Step 2: Build the final list of nodes from the winners identified in Step 1.
		for _, latestID := range macToNodeID {
			latestNodes[latestID] = nodeStatus[latestID]
		}

		// After deduplication, check for staleness
		now := time.Now()
		for _, info := range latestNodes {
			if info.Updated != "" {
				updatedTime, err := time.Parse("2006-01-02 15:04:05", info.Updated)
				if err == nil {
					if now.Sub(updatedTime) > 10*time.Second {
						info.Status = "offline" // Mark as offline if older than 10s
					}
				}
			}
		}

		return c.JSON(latestNodes)
	})

	// DELETE node endpoint
	app.Delete("/api/nodes/:id", func(c *fiber.Ctx) error {
		id := c.Params("id")
		nodeMutex.Lock()
		defer nodeMutex.Unlock()

		// Find the MAC of the node to be deleted
		matches := macRegex.FindAllString(id, -1)
		if len(matches) == 0 {
			// If no MAC found, just delete the specific node
			if _, ok := nodeStatus[id]; ok {
				delete(nodeStatus, id)
				// Clear its retained messages
				mqttClient.Publish(fmt.Sprintf("nodes/%s/status", id), 0, true, []byte{})
				mqttClient.Publish(fmt.Sprintf("nodes/%s/monitor", id), 0, true, []byte{})
				return c.JSON(fiber.Map{"status": "deleted", "node": id})
			}
			return c.Status(http.StatusNotFound).JSON(fiber.Map{"error": "node not found"})
		}
		targetMac := matches[len(matches)-1]

		// Iterate over all nodes and delete any that match the target MAC
		nodesToDelete := []string{}
		deletedCount := 0
		for nodeID := range nodeStatus {
			nodeMacMatches := macRegex.FindAllString(nodeID, -1)
			if len(nodeMacMatches) > 0 && nodeMacMatches[len(nodeMacMatches)-1] == targetMac {
				nodesToDelete = append(nodesToDelete, nodeID)
			}
		}

		for _, nodeID := range nodesToDelete {
			delete(nodeStatus, nodeID)
			mqttClient.Publish(fmt.Sprintf("nodes/%s/status", nodeID), 0, true, []byte{})
			mqttClient.Publish(fmt.Sprintf("nodes/%s/monitor", nodeID), 0, true, []byte{})
			deletedCount++
		}

		if deletedCount > 0 {
			return c.JSON(fiber.Map{"status": "deleted", "mac": targetMac, "count": deletedCount})
		}

		return c.Status(http.StatusNotFound).JSON(fiber.Map{"error": "no nodes found for the given ID or MAC"})
	})

	// API: files list
	app.Get("/api/files", func(c *fiber.Ctx) error {
		fileMutex.RLock()
		defer fileMutex.RUnlock()
		files := make([]FileInfo, 0, len(fileInfos))
		for _, f := range fileInfos {
			files = append(files, f)
		}
		return c.JSON(files)
	})

	// DELETE file endpoint
	app.Delete("/api/files/:name", func(c *fiber.Ctx) error {
		name := c.Params("name")
		// security: prevent path traversal
		clean := filepath.Base(name)
		path := filepath.Join("static", "uploads", clean)

		fileMutex.Lock()
		defer fileMutex.Unlock()

		if _, err := os.Stat(path); os.IsNotExist(err) {
			return c.Status(http.StatusNotFound).JSON(fiber.Map{"error": "file not found"})
		}
		if err := os.Remove(path); err != nil {
			return c.Status(http.StatusInternalServerError).JSON(fiber.Map{"error": "failed delete"})
		}
		delete(fileInfos, clean)
		return c.JSON(fiber.Map{"status": "deleted", "name": clean})
	})

	// RENAME file endpoint
	app.Post("/api/files/:name/rename", func(c *fiber.Ctx) error {
		name := c.Params("name")
		type RenameRequest struct {
			NewName string `json:"new_name"`
		}
		var req RenameRequest
		if err := c.BodyParser(&req); err != nil {
			return c.Status(http.StatusBadRequest).JSON(fiber.Map{"error": "invalid body"})
		}

		// Sanitize new file name to prevent path traversal or invalid names
		cleanNewName := filepath.Base(req.NewName)
		if cleanNewName == "" || cleanNewName == "." || cleanNewName == ".." {
			return c.Status(http.StatusBadRequest).JSON(fiber.Map{"error": "invalid new name"})
		}

		fileMutex.Lock()
		defer fileMutex.Unlock()

		if _, ok := fileInfos[name]; !ok {
			return c.Status(http.StatusNotFound).JSON(fiber.Map{"error": "file not found"})
		}

		oldPath := filepath.Join("static", "uploads", name)
		newPath := filepath.Join("static", "uploads", cleanNewName)

		if err := os.Rename(oldPath, newPath); err != nil {
			return c.Status(http.StatusInternalServerError).JSON(fiber.Map{"error": "failed to rename file"})
		}

		fileInfo := fileInfos[name]
		delete(fileInfos, name)
		fileInfo.Name = cleanNewName
		fileInfo.URL = "/files/" + cleanNewName
		fileInfos[cleanNewName] = fileInfo

		return c.JSON(fileInfo)
	})

	// Upload OTA (form multipart)
	app.Post("/upload", func(c *fiber.Ctx) error {
		f, err := c.FormFile("file")
		if err != nil {
			return c.Status(http.StatusBadRequest).SendString("file required")
		}
		dst := filepath.Join("static", "uploads", filepath.Base(f.Filename))
		if err := c.SaveFile(f, dst); err != nil {
			return err
		}

		fileMutex.Lock()
		defer fileMutex.Unlock()
		fileInfos[f.Filename] = FileInfo{
			Name:       f.Filename,
			URL:        "/files/" + f.Filename,
			UploadTime: time.Now(),
		}

		return c.Redirect("/")
	})

	// Config -> publish to nodes/{id}/command
	app.Post("/config", func(c *fiber.Ctx) error {
		type T struct {
			Node string  `json:"node"`
			Min  float64 `json:"min"`
			Max  float64 `json:"max"`
			Ck   string  `json:"ck"`
			Area string  `json:"area"`
			No   string  `json:"no"`
		}
		var t T
		if err := c.BodyParser(&t); err != nil {
			return c.Status(400).JSON(fiber.Map{"error": "invalid body"})
		}
		payload := map[string]interface{}{"cmd": "set_threshold", "min": t.Min, "max": t.Max, "ck": t.Ck, "area": t.Area, "no": t.No}
		b, err := json.Marshal(payload)
		if err != nil {
			return c.Status(http.StatusInternalServerError).JSON(fiber.Map{"error": "failed to create payload"})
		}

		// Save the config values to the node's state
		nodeMutex.Lock()
		if info, ok := nodeStatus[t.Node]; ok {
			info.Ck, info.Area, info.No = t.Ck, t.Area, t.No
		}
		nodeMutex.Unlock()

		topic := fmt.Sprintf("nodes/%s/command", t.Node)
		token := mqttClient.Publish(topic, 0, false, b)
		token.Wait()
		return c.JSON(fiber.Map{"status": "ok", "topic": topic})
	})

	// OTA trigger
	app.Post("/ota", func(c *fiber.Ctx) error {
		type O struct {
			Node string `json:"node"`
			URL  string `json:"url"`
		}
		var o O
		if err := c.BodyParser(&o); err != nil {
			return c.Status(400).JSON(fiber.Map{"error": "invalid body"})
		}
		payload := map[string]interface{}{"cmd": "ota", "url": o.URL}
		b, err := json.Marshal(payload)
		if err != nil {
			return c.Status(http.StatusInternalServerError).JSON(fiber.Map{"error": "failed to create payload"})
		}
		topic := fmt.Sprintf("nodes/%s/command", o.Node)
		token := mqttClient.Publish(topic, 0, false, b)
		token.Wait()
		return c.JSON(fiber.Map{"status": "OTA triggered", "topic": topic})
	})

	// logs endpoint (last 3 lines)
	app.Get("/logs/:id", func(c *fiber.Ctx) error {
		id := c.Params("id")
		nodeMutex.RLock()
		defer nodeMutex.RUnlock()
		if info, ok := nodeStatus[id]; ok {
			return c.JSON(fiber.Map{"node": id, "logs": info.Logs})
		}
		return c.Status(404).JSON(fiber.Map{"error": "node not found"})
	})

	// Start MQTT connection (non-blocking)
	go initMQTT()

	// Listen
	log.Fatal(app.Listen("0.0.0.0:9999"))
}

func loadInitialFiles(dir string) {
	fileMutex.Lock()
	defer fileMutex.Unlock()

	entries, err := os.ReadDir(dir)
	if err != nil {
		log.Printf("could not read upload directory %s: %v", dir, err)
		return
	}

	for _, entry := range entries {
		if !entry.IsDir() {
			info, err := entry.Info()
			if err == nil {
				name := info.Name()
				fileInfos[name] = FileInfo{Name: name, URL: "/files/" + name, UploadTime: info.ModTime()}
			}
		}
	}
}

func initMQTT() {
	// broker and creds
	brokerHost := getEnv("MQTT_BROKER", "tcp://172.20.100.11:1883")
	mqttUser := getEnv("MQTT_USER", "cntrl")
	mqttPass := getEnv("MQTT_PASS", "")

	opts := mqtt.NewClientOptions()
	opts.AddBroker(brokerHost)
	opts.SetClientID(fmt.Sprintf("web-%d", time.Now().Unix()))
	if mqttUser != "" {
		opts.SetUsername(mqttUser)
	}
	if mqttPass != "" {
		opts.SetPassword(mqttPass)
	}
	opts.AutoReconnect = true
	opts.OnConnect = func(c mqtt.Client) {
		log.Println("MQTT connected to", brokerHost)
		// subscribe status/topic patterns
		if token := c.Subscribe("nodes/+/status", 0, mqttHandler); token.Wait() && token.Error() != nil {
			log.Println("subscribe status err:", token.Error())
		}
		if token := c.Subscribe("nodes/+/monitor", 0, mqttHandler); token.Wait() && token.Error() != nil {
			log.Println("subscribe nodes/+/monitor err:", token.Error())
		}
		// support firmware publishing to "<node>/monitor" or "nodes/<node>/monitor"
		if token := c.Subscribe("+/monitor", 0, mqttHandler); token.Wait() && token.Error() != nil {
			log.Println("subscribe +/monitor err:", token.Error())
		}
		// subscribe logs
		if token := c.Subscribe("nodes/+/log", 0, mqttHandler); token.Wait() && token.Error() != nil {
			log.Println("subscribe nodes/+/log err:", token.Error())
		}
	}
	opts.OnConnectionLost = func(c mqtt.Client, err error) {
		log.Println("MQTT lost:", err)
	}

	mqttClient = mqtt.NewClient(opts)
	for {
		if token := mqttClient.Connect(); token.Wait() && token.Error() == nil {
			break
		} else {
			log.Println("waiting for mqtt broker, retry in 2s...")
			time.Sleep(2 * time.Second)
		}
	}
}

// mqttHandler parses status, monitor, log messages
func mqttHandler(client mqtt.Client, msg mqtt.Message) {
	topic := msg.Topic()
	parts := strings.Split(topic, "/")
	if len(parts) < 2 {
		return
	}

	var nodeID, sub string
	if parts[0] == "nodes" && len(parts) >= 3 {
		nodeID = parts[1]
		sub = parts[2]
	} else if len(parts) >= 2 {
		nodeID = parts[0]
		sub = parts[1]
	} else {
		return
	}

	raw := msg.Payload()
	now := time.Now().Format("2006-01-02 15:04:05")

	nodeMutex.Lock()
	defer nodeMutex.Unlock()

	// --- Smart Node Migration Logic ---
	// If a new nodeID appears for an existing MAC, migrate config and delete the old one.
	if _, ok := nodeStatus[nodeID]; !ok {
		newMacMatches := macRegex.FindAllString(nodeID, -1)
		if len(newMacMatches) > 0 {
			newMac := newMacMatches[len(newMacMatches)-1]
			// Find the old node ID with the same MAC
			for oldID, oldInfo := range nodeStatus {
				if oldID == nodeID {
					continue
				}
				oldMacMatches := macRegex.FindAllString(oldID, -1)
				if len(oldMacMatches) > 0 && oldMacMatches[len(oldMacMatches)-1] == newMac {
					// Found an old node for this MAC. Migrate data and delete it.
					log.Printf("Migrating config from old node '%s' to new node '%s'", oldID, nodeID)
					newNodeInfo := &NodeInfo{Ck: oldInfo.Ck, Area: oldInfo.Area, No: oldInfo.No}
					nodeStatus[nodeID] = newNodeInfo
					delete(nodeStatus, oldID)
					break // Assume only one old node per MAC
				}
			}
		}
	}

	if _, ok := nodeStatus[nodeID]; !ok {
		nodeStatus[nodeID] = &NodeInfo{}
	}
	info := nodeStatus[nodeID]

	switch sub {
	case "status":
		var tmp interface{}
		if err := json.Unmarshal(raw, &tmp); err == nil {
			if m, ok := tmp.(map[string]interface{}); ok {
				if s, ex := m["state"]; ex {
					info.Status = fmt.Sprintf("%v", s)
				} else {
					info.Status = fmt.Sprintf("%v", tmp)
				}
			} else {
				info.Status = fmt.Sprintf("%v", tmp)
			}
		} else {
			info.Status = string(raw)
		}
		info.Updated = now

	case "monitor":
		var m map[string]interface{}
		if err := json.Unmarshal(raw, &m); err == nil {
			if v, ok := m["ram_free_bytes"]; ok {
				if val, ok := v.(float64); ok { // JSON numbers are float64 by default
					info.RamFreeBytes = int64(val)
				}
			}
			if v, ok := m["sd_ok"]; ok {
				if b, ok := v.(bool); ok {
					info.SD_OK = &b
				}
			}
			// optionally parse other fields if present
		}
		// Log if unmarshal fails, to help debug malformed payloads from devices
		// else { log.Printf("failed to unmarshal monitor payload from %s: %s", nodeID, string(raw)) }
		info.Updated = now

	case "log":
		// log lines are text; append and keep last 3
		line := string(raw)
		// sanitize: trim
		line = strings.TrimSpace(line)
		if line != "" {
			// append
			info.Logs = append(info.Logs, line)
			if len(info.Logs) > 3 {
				info.Logs = info.Logs[len(info.Logs)-3:]
			}
			info.Updated = now
		}
	default:
		// ignore
	}
	nodeStatus[nodeID] = info
}
