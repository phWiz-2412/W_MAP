/**
 * Source of navigation packets (NavigationPacket, serialized as JSON). The simulator implements
 * this today; a BLE provider can implement it later without UI changes.
 *
 * Providers emit RAW messages (JSON strings), as they would arrive over a wire.
 * Parsing, validation and sequence filtering are done by the consumer
 * (see useNavigationData), so a real transport gets the same protection.
 */
export interface NavigationDataProvider {
  readonly id: string;
  readonly label: string;
  /** True if data is synthetic. The UI must label simulated sources. */
  readonly isSimulated: boolean;
  /** Subscribe to raw messages. Returns an unsubscribe function. */
  subscribe(listener: (rawMessage: string) => void): () => void;
  /** Release timers and listeners. */
  dispose(): void;
}
