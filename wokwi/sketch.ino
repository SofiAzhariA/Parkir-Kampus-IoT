/*
 * =====================================================================
 *  SMARTPARK KAMPUS - Sistem IoT Prediksi Ketersediaan Parkir
 * =====================================================================
 *  Mikrokontroler : ESP32 DevKit V1
 *  Sensor         : HC-SR04 Ultrasonik x4 (deteksi per slot)
 *  Output         : LED Indikator, LCD I2C, Servo Gate, Buzzer
 *  Komunikasi     : WiFi → HTTP POST ke server dashboard
 *  Dataset Dasar  : CASAS Smart Home IoT (adaptasi pola temporal)
 * =====================================================================
 *  Pin Assignment:
 *    Sensor Slot A1 : TRIG=13, ECHO=12
 *    Sensor Slot A2 : TRIG=14, ECHO=27
 *    Sensor Slot B1 : TRIG=26, ECHO=25
 *    Sensor Slot B2 : TRIG=33, ECHO=32
 *    LED Slot A1    : GPIO 4
 *    LED Slot A2    : GPIO 5
 *    LED Slot B1    : GPIO 18
 *    LED Slot B2    : GPIO 19
 *    LED WiFi Status: GPIO 23
 *    LCD SDA        : GPIO 21
 *    LCD SCL        : GPIO 22
 *    Servo Gate     : GPIO 15
 *    Buzzer         : GPIO 2
 * =====================================================================
 */

#include <ArduinoJson.h>
#include <ESP32Servo.h>
#include <HTTPClient.h>
#include <LiquidCrystal_I2C.h>
#include <WiFi.h>
#include <Wire.h>
#include <time.h>
#include <PubSubClient.h>

// ─── WiFi Config ─────────────────────────────────────────────
// Catatan: Gunakan "Wokwi-GUEST" dan "" saat simulasi di Wokwi
const char *WIFI_SSID = "Wokwi-GUEST";
const char *WIFI_PASSWORD = "";

// ─── Server Config ────────────────────────────────────────────
// Ganti dengan IP server dashboard Anda jika menggunakan backend HTTP REST
const char *SERVER_URL = "http://192.168.1.100:5000/api/parking";

// ─── MQTT Config ──────────────────────────────────────────────
const char *MQTT_BROKER = "broker.hivemq.com";
const int MQTT_PORT = 1883;
const char *MQTT_TOPIC = "smartpark/kampus/occupancy";

WiFiClient espClient;
PubSubClient mqttClient(espClient);

// ─── Pin Definitions ─────────────────────────────────────────
#define TRIG1 13
#define ECHO1 12 // Slot A1
#define TRIG2 14
#define ECHO2 27 // Slot A2
#define TRIG3 26
#define ECHO3 25 // Slot B1
#define TRIG4 33
#define ECHO4 32 // Slot B2

#define LED_SLOT_A1 4
#define LED_SLOT_A2 5
#define LED_SLOT_B1 18
#define LED_SLOT_B2 19
#define LED_WIFI 23

#define SERVO_PIN 15
#define BUZZER_PIN 2

// ─── Threshold & Konfigurasi ─────────────────────────────────
#define JARAK_TERISI_CM 20      // Jarak (cm) dianggap slot terisi
#define KAPASITAS_TOTAL 4       // Total slot yang dimonitor
#define INTERVAL_BACA_MS 500    // Interval baca sensor (ms)
#define INTERVAL_KIRIM_MS 10000 // Interval kirim data ke server (ms)
#define SERVO_BUKA 90           // Sudut servo saat gate terbuka
#define SERVO_TUTUP 0           // Sudut servo saat gate tertutup

// ─── Objek ───────────────────────────────────────────────────
LiquidCrystal_I2C lcd(0x27, 16, 2);
Servo servoGate;

// ─── State ───────────────────────────────────────────────────
struct SlotParkir {
  int trigPin;
  int echoPin;
  int ledPin;
  bool terisi;
  float jarakCm;
  String nama;
};

SlotParkir slots[4] = {
    {TRIG1, ECHO1, LED_SLOT_A1, false, 999, "Slot A1"},
    {TRIG2, ECHO2, LED_SLOT_A2, false, 999, "Slot A2"},
    {TRIG3, ECHO3, LED_SLOT_B1, false, 999, "Slot B1"},
    {TRIG4, ECHO4, LED_SLOT_B2, false, 999, "Slot B2"},
};

int slotTerisi = 0;
int slotTersedia = KAPASITAS_TOTAL;
bool wifiConnected = false;
bool gateTerbuka = false;

unsigned long lastSendTime = 0;
unsigned long lastReadTime = 0;
unsigned long lastMqttReconnectAttempt = 0;

// ─── Karakter LCD Kustom ─────────────────────────────────────
byte charPenuh[8] = {0b11111, 0b10001, 0b10001, 0b11111,
                     0b11111, 0b10001, 0b10001, 0b11111};
byte charKosong[8] = {0b11111, 0b10001, 0b10001, 0b10001,
                      0b10001, 0b10001, 0b10001, 0b11111};

// ─────────────────────────────────────────────────────────────
// SETUP
// ─────────────────────────────────────────────────────────────
void setup() {
  Serial.begin(115200);
  Serial.println("\n=== SmartPark Kampus IoT Booting... ===");

  // Init pin
  int trigPins[] = {TRIG1, TRIG2, TRIG3, TRIG4};
  int echoPins[] = {ECHO1, ECHO2, ECHO3, ECHO4};
  int ledPins[] = {LED_SLOT_A1, LED_SLOT_A2, LED_SLOT_B1, LED_SLOT_B2};

  for (int i = 0; i < 4; i++) {
    pinMode(trigPins[i], OUTPUT);
    pinMode(echoPins[i], INPUT);
    pinMode(ledPins[i], OUTPUT);
    digitalWrite(ledPins[i], LOW); // LED mati dulu
  }
  pinMode(LED_WIFI, OUTPUT);
  pinMode(BUZZER_PIN, OUTPUT);

  // Init LCD
  Wire.begin(21, 22);
  lcd.init();
  lcd.backlight();
  lcd.createChar(0, charPenuh);
  lcd.createChar(1, charKosong);

  tampilkanBootScreen();

  // Init Servo
  servoGate.attach(SERVO_PIN);
  servoGate.write(SERVO_TUTUP);

  // Koneksi WiFi
  koneksiWiFi();

  // Sync waktu NTP
  if (wifiConnected) {
    configTime(7 * 3600, 0, "pool.ntp.org", "time.nist.gov");
    Serial.println("[NTP] Sinkronisasi waktu...");
    
    // Init MQTT
    mqttClient.setServer(MQTT_BROKER, MQTT_PORT);
    hubungkanMQTT();
  }

  Serial.println("[BOOT] Sistem siap!");
  bunyikanBuzzer(1, 100); // Beep sekali tanda siap
}

// ─────────────────────────────────────────────────────────────
// LOOP UTAMA
// ─────────────────────────────────────────────────────────────
void loop() {
  unsigned long now = millis();

  // Pemeliharaan koneksi MQTT (Non-blocking)
  if (wifiConnected) {
    if (!mqttClient.connected()) {
      unsigned long nowMqtt = millis();
      if (nowMqtt - lastMqttReconnectAttempt > 5000) {
        lastMqttReconnectAttempt = nowMqtt;
        hubungkanMQTT();
      }
    } else {
      mqttClient.loop();
    }
  }

  // 1. Baca sensor setiap INTERVAL_BACA_MS
  if (now - lastReadTime >= INTERVAL_BACA_MS) {
    bacaSemuaSensor();
    updateLED();
    updateLCD();
    cekKondisiKritis();
    lastReadTime = now;
  }

  // 2. Kirim data ke server setiap INTERVAL_KIRIM_MS
  if (wifiConnected && (now - lastSendTime >= INTERVAL_KIRIM_MS)) {
    kirimDataKeServer();
    lastSendTime = now;
  }

  // 3. Tampilkan status serial monitor
  if (now % 5000 < 10) {
    tampilkanStatusSerial();
  }
}

// ─────────────────────────────────────────────────────────────
// FUNGSI SENSOR ULTRASONIK
// ─────────────────────────────────────────────────────────────
float bacaJarak(int trigPin, int echoPin) {
  // Kirim pulse trigger 10μs
  digitalWrite(trigPin, LOW);
  delayMicroseconds(2);
  digitalWrite(trigPin, HIGH);
  delayMicroseconds(10);
  digitalWrite(trigPin, LOW);

  // Baca durasi echo
  long durasi = pulseIn(echoPin, HIGH, 30000); // timeout 30ms

  if (durasi == 0)
    return 999.0; // Tidak ada respons = objek sangat jauh

  // Hitung jarak: v_suara = 343 m/s = 0.0343 cm/μs
  // jarak = (durasi * 0.0343) / 2
  float jarak = (durasi * 0.0343) / 2.0;
  return jarak;
}

void bacaSemuaSensor() {
  slotTerisi = 0;

  for (int i = 0; i < 4; i++) {
    slots[i].jarakCm = bacaJarak(slots[i].trigPin, slots[i].echoPin);
    bool terisiSebelum = slots[i].terisi;
    slots[i].terisi = (slots[i].jarakCm < JARAK_TERISI_CM);

    // Log perubahan status
    if (slots[i].terisi != terisiSebelum) {
      Serial.printf("[SENSOR] %s: %s (%.1f cm)\n", slots[i].nama.c_str(),
                    slots[i].terisi ? "TERISI" : "KOSONG", slots[i].jarakCm);

      // Beep saat ada perubahan
      if (slots[i].terisi) {
        bunyikanBuzzer(1, 80); // Kendaraan masuk: 1 beep
      } else {
        bunyikanBuzzer(2, 80); // Kendaraan keluar: 2 beep
      }
    }

    if (slots[i].terisi)
      slotTerisi++;
  }

  slotTersedia = KAPASITAS_TOTAL - slotTerisi;
}

// ─────────────────────────────────────────────────────────────
// FUNGSI LED INDIKATOR
// ─────────────────────────────────────────────────────────────
void updateLED() {
  for (int i = 0; i < 4; i++) {
    // LED MERAH = slot terisi, LED MATI = kosong
    digitalWrite(slots[i].ledPin, slots[i].terisi ? HIGH : LOW);
  }

  // LED WiFi: berkedip jika tidak terhubung, nyala tetap jika terhubung
  digitalWrite(LED_WIFI,
               wifiConnected ? HIGH : (millis() % 1000 < 200 ? HIGH : LOW));
}

// ─────────────────────────────────────────────────────────────
// FUNGSI LCD
// ─────────────────────────────────────────────────────────────
void updateLCD() {
  lcd.clear();

  // Baris 1: Judul + waktu
  lcd.setCursor(0, 0);
  lcd.print("SmartPark Kampus");

  // Baris 2: Status slot
  lcd.setCursor(0, 1);
  float persenTerisi = (float)slotTerisi / KAPASITAS_TOTAL * 100.0;

  if (slotTersedia == 0) {
    lcd.print("PENUH! 0 tersedia");
  } else {
    char buffer[17];
    snprintf(buffer, sizeof(buffer), "%d/%d Terisi  %d OK", slotTerisi, KAPASITAS_TOTAL,
               slotTersedia);
    lcd.print(buffer);
  }
}

void tampilkanBootScreen() {
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print("SmartPark  v1.0 ");
  lcd.setCursor(0, 1);
  lcd.print("Initializing... ");
  delay(1500);

  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print("Slot: ");
  lcd.print(KAPASITAS_TOTAL);
  lcd.print(" total  ");
  lcd.setCursor(0, 1);
  lcd.print("Sensor OK!      ");
  delay(1000);
}

// ─────────────────────────────────────────────────────────────
// FUNGSI SERVO GATE
// ─────────────────────────────────────────────────────────────
void bukaGate() {
  if (!gateTerbuka) {
    servoGate.write(SERVO_BUKA);
    gateTerbuka = true;
    Serial.println("[GATE] Gate TERBUKA");
  }
}

void tutupGate() {
  if (gateTerbuka) {
    servoGate.write(SERVO_TUTUP);
    gateTerbuka = false;
    Serial.println("[GATE] Gate TERTUTUP");
  }
}

// ─────────────────────────────────────────────────────────────
// FUNGSI CEK KONDISI KRITIS
// ─────────────────────────────────────────────────────────────
void cekKondisiKritis() {
  if (slotTersedia == 0) {
    // Parkir PENUH: tutup gate, alarm
    tutupGate();
    // Buzzer alarm panjang setiap 5 detik
    static unsigned long lastAlarm = 0;
    if (millis() - lastAlarm > 5000) {
      bunyikanBuzzer(3, 200);
      lastAlarm = millis();
    }

    // Update LCD khusus
    lcd.setCursor(0, 0);
    lcd.print("!!! PENUH !!!   ");
    lcd.setCursor(0, 1);
    lcd.print("Cari zona lain  ");
  } else {
    // Ada slot tersedia: buka gate
    bukaGate();
  }
}

// ─────────────────────────────────────────────────────────────
// FUNGSI BUZZER
// ─────────────────────────────────────────────────────────────
void bunyikanBuzzer(int kali, int durasiMs) {
  for (int i = 0; i < kali; i++) {
    digitalWrite(BUZZER_PIN, HIGH);
    delay(durasiMs);
    digitalWrite(BUZZER_PIN, LOW);
    if (i < kali - 1)
      delay(100);
  }
}

// ─────────────────────────────────────────────────────────────
// FUNGSI WIFI
// ─────────────────────────────────────────────────────────────
void koneksiWiFi() {
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print("Koneksi WiFi...");
  Serial.printf("[WiFi] Connecting to %s", WIFI_SSID);

  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 20) {
    delay(500);
    Serial.print(".");
    lcd.setCursor(attempts % 16, 1);
    lcd.print(".");
    attempts++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    wifiConnected = true;
    Serial.printf("\n[WiFi] Connected! IP: %s\n",
                  WiFi.localIP().toString().c_str());
    lcd.clear();
    lcd.setCursor(0, 0);
    lcd.print("WiFi Terhubung!");
    lcd.setCursor(0, 1);
    lcd.print(WiFi.localIP().toString());
    bunyikanBuzzer(2, 100);
    delay(1500);
  } else {
    wifiConnected = false;
    Serial.println("\n[WiFi] GAGAL! Mode offline.");
    lcd.clear();
    lcd.setCursor(0, 0);
    lcd.print("WiFi GAGAL!     ");
    lcd.setCursor(0, 1);
    lcd.print("Mode offline... ");
    delay(1500);
  }
}

// ─────────────────────────────────────────────────────────────
// FUNGSI MQTT & KIRIM DATA
// ─────────────────────────────────────────────────────────────
bool hubungkanMQTT() {
  if (mqttClient.connected()) return true;

  Serial.print("[MQTT] Menghubungkan ke Broker...");
  String clientId = "SmartParkClient-" + String(random(0xffff), HEX);
  if (mqttClient.connect(clientId.c_str())) {
    Serial.println("TERHUBUNG!");
    return true;
  } else {
    Serial.print("GAGAL, rc=");
    Serial.println(mqttClient.state());
    return false;
  }
}

void kirimDataKeServer() {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[WiFi] Tidak ada koneksi WiFi, skip kirim.");
    wifiConnected = false;
    return;
  }

  // Ambil waktu sekarang
  struct tm timeinfo;
  char timestamp[25];
  if (!getLocalTime(&timeinfo)) {
    snprintf(timestamp, sizeof(timestamp), "1970-01-01T00:00:00");
  } else {
    strftime(timestamp, sizeof(timestamp), "%Y-%m-%dT%H:%M:%S", &timeinfo);
  }

  // Build JSON payload
  #if ARDUINOJSON_VERSION_MAJOR >= 7
  JsonDocument doc;
  #else
  StaticJsonDocument<512> doc;
  #endif
  doc["timestamp"] = timestamp;
  doc["total_slot"] = KAPASITAS_TOTAL;
  doc["slot_terisi"] = slotTerisi;
  doc["slot_tersedia"] = slotTersedia;
  doc["occupancy_rate"] = (float)slotTerisi / KAPASITAS_TOTAL;
  doc["gate_status"] = gateTerbuka ? "open" : "closed";
  doc["device_id"] = "SMARTPARK-ESP32-001";

  for (int i = 0; i < 4; i++) {
    doc["slots"][i]["id"] = slots[i].nama;
    doc["slots"][i]["terisi"] = slots[i].terisi;
    doc["slots"][i]["jarak_cm"] = slots[i].jarakCm;
  }

  String jsonStr;
  serializeJson(doc, jsonStr);

  // ─── Kirim via MQTT ───
  if (mqttClient.connected()) {
    Serial.printf("[MQTT] Publish ke topik %s...\n", MQTT_TOPIC);
    if (mqttClient.publish(MQTT_TOPIC, jsonStr.c_str())) {
      Serial.println("[MQTT] Data berhasil di-publish!");
    } else {
      Serial.println("[MQTT] Gagal mempublikasikan data.");
    }
  } else {
    Serial.println("[MQTT] Broker offline, melewatkan publish.");
  }

  // ─── Kirim via HTTP POST (Opsional / fallback) ───
  Serial.printf("[HTTP] Mengirim ke %s\n", SERVER_URL);
  Serial.printf("[HTTP] Payload: %s\n", jsonStr.c_str());

  HTTPClient http;
  http.begin(SERVER_URL);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-Device-Key", "smartpark-secret-key");

  int httpCode = http.POST(jsonStr);

  if (httpCode > 0) {
    Serial.printf("[HTTP] Response code: %d\n", httpCode);
    if (httpCode == HTTP_CODE_OK) {
      String response = http.getString();
      Serial.printf("[HTTP] Response: %s\n", response.c_str());
    }
  } else {
    Serial.printf("[HTTP] ERROR: %s\n", http.errorToString(httpCode).c_str());
  }

  http.end();
}

// ─────────────────────────────────────────────────────────────
// SERIAL MONITOR STATUS
// ─────────────────────────────────────────────────────────────
void tampilkanStatusSerial() {
  Serial.println("\n===========================");
  Serial.printf("  SmartPark Status\n");
  Serial.printf("  Slot Terisi  : %d/%d\n", slotTerisi, KAPASITAS_TOTAL);
  Serial.printf("  Slot Tersedia: %d\n", slotTersedia);
  Serial.printf("  Hunian       : %.0f%%\n",
                (float)slotTerisi / KAPASITAS_TOTAL * 100);
  Serial.println("---------------------------");
  for (int i = 0; i < 4; i++) {
    Serial.printf("  %s: %s (%.1f cm)\n", slots[i].nama.c_str(),
                  slots[i].terisi ? "[TERISI] " : "[KOSONG] ",
                  slots[i].jarakCm);
  }
  Serial.printf("  WiFi  : %s\n", wifiConnected ? "TERHUBUNG" : "OFFLINE");
  Serial.printf("  Gate  : %s\n", gateTerbuka ? "BUKA" : "TUTUP");
  Serial.println("===========================\n");
}
