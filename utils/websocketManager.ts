export class WebSocketManager {
	retryCount: number = 0;
	baseDelay = 1000; // Start with 1 second
	maxDelay = 30000; // Cap at 30 seconds
	ws: WebSocket | null = null;
	subscriptions: Map<string, { method: string; params: any; callback: (data: any) => void }> =
		new Map();
	isReconnecting = false;

	constructor(
		private url: string,
		private maxRetries = 10
	) {
		this.subscriptions = new Map();
		this.isReconnecting = false;
	}

	connect() {
		if (this.isReconnecting) return;

		try {
			this.ws = new WebSocket(this.url);
			this.setupEventHandlers();
		} catch (error) {
			console.error('Failed to create WebSocket:', error);
			this.scheduleReconnect();
		}
	}

	setupEventHandlers() {
		this.ws!.onopen = () => {
			console.log('Connected successfully');
			this.retryCount = 0; // Reset retry count on successful connection
			this.isReconnecting = false;
			this.resubscribeAll(); // Restore subscriptions
		};

		this.ws!.onmessage = (event) => {
			console.log('Received message:', event.data);
		};

		this.ws!.onclose = (event) => {
			console.log('Connection closed:', event.code, event.reason);
			if (!this.isReconnecting) {
				this.scheduleReconnect();
			}
		};

		this.ws!.onerror = (error) => {
			console.error('WebSocket error:', error);
		};
	}

	scheduleReconnect() {
		if (this.retryCount >= this.maxRetries) {
			console.error('Max retry attempts reached. Giving up.');
			return;
		}

		this.isReconnecting = true;
		this.retryCount++;

		// Calculate delay with exponential backoff + jitter
		const delay = Math.min(this.baseDelay * Math.pow(2, this.retryCount - 1), this.maxDelay);

		// Add jitter to prevent thundering herd
		const jitteredDelay = delay + Math.random() * 1000;

		console.log(
			`Reconnecting in ${jitteredDelay}ms (attempt ${this.retryCount}/${this.maxRetries})`
		);

		setTimeout(() => {
			this.connect();
		}, jitteredDelay);
	}

	subscribe(method: string, params: any, callback: (data: any) => void) {
		const id = this.generateId();
		this.subscriptions.set(id, { method, params, callback });

		if (this.ws && this.ws.readyState === WebSocket.OPEN) {
			this.sendSubscription(id, method, params);
		}

		return id;
	}

	resubscribeAll() {
		console.log(`Restoring ${this.subscriptions.size} subscriptions`);
		for (const [id, sub] of this.subscriptions) {
			this.sendSubscription(id, sub.method, sub.params);
		}
	}

	sendSubscription(id: string, method: string, params: any) {
		console.log(params);
		this.ws!.send(
			JSON.stringify({
				jsonrpc: '2.0',
				id: id,
				method: method,
				params: params
			})
		);
	}

	generateId(): string {
		return Date.now() + Math.random().toString();
	}
}
