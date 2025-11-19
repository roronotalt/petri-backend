import { WebSocketManager } from './utils/websocketManager';

export class SolanaUpdater {
	private helius_url = `wss://${process.env.ENV === 'DEV' ? 'devnet' : 'mainnet'}.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;
	private wsManager: WebSocketManager;
	constructor() {
		this.wsManager = new WebSocketManager(this.helius_url);
		this.wsManager.connect();

		this.wsManager.subscribe(
			'logsSubscribe',
			[
				{
					mentions: ['GAWPxFmYubMHsKY6yZGdzXNYcJREru22MYYjihEbTUUK']
				},
				{
					commitment: 'confirmed'
				}
			],
			(data) => {
				console.log(data);
			}
		);
	}
}
