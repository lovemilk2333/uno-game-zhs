// Test setup file for Vitest
// Add any global test configuration here

// Mock WebSocket for testing if needed
global.WebSocket = class MockWebSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 1; // OPEN
    setTimeout(() => {
      if (this.onopen) this.onopen();
    }, 0);
  }

  send(data) {
    // Mock send implementation
    console.log("Mock WebSocket send:", data);
  }

  close() {
    this.readyState = 3; // CLOSED
    if (this.onclose) this.onclose();
  }
};
