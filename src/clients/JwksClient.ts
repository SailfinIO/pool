/**
 * @fileoverview
 * Provides a client for managing and retrieving JSON Web Keys (JWKs) from a JWKS URI.
 * This class includes caching, validation, and efficient key lookup by Key ID (kid).
 *
 * @module src/clients/JwksClient
 */

import { InMemoryCache } from '../cache/InMemoryCache';
import { ClientError } from '../errors/ClientError';
import { ILogger, IHttpClient, Jwk, JwksResponse, ICache } from '../interfaces';
import { HTTPClient } from './HTTPClient';

/**
 * Represents a client for managing and retrieving JSON Web Keys (JWKs) from a JWKS URI.
 *
 * The `JwksClient` class handles fetching, caching, and validating JWKS responses,
 * and provides methods to retrieve a JWK by its Key ID (kid).
 *
 * @class JwksClient
 */
export class JwksClient {
  /**
   * Promise to manage concurrent JWKS fetches.
   *
   * @private
   * @type {Promise<void> | null}
   */
  private fetchingJWKS: Promise<void> | null = null;

  /**
   * The cache key used to store the JWKS.
   *
   * @private
   * @type {string}
   */
  private cacheKey: string = 'jwks';

  /**
   * Creates an instance of JwksClient.
   *
   * @param {string} jwksUri - The URI to fetch the JWKS from.
   * @param {ILogger} logger - Logger instance for logging operations and errors.
   * @param {IHttpClient} [httpClient] - HTTP client for making requests. Defaults to `HTTPClient`.
   * @param {ICache<Jwk[]>} [cache] - Cache instance for storing JWKS. Defaults to `InMemoryCache`.
   * @param {number} [cacheTtl=3600000] - Time-to-live for the cache in milliseconds. Defaults to 1 hour.
   * @throws {ClientError} If the provided JWKS URI is invalid.
   */
  constructor(
    private jwksUri: string,
    private logger: ILogger,
    private httpClient: IHttpClient = new HTTPClient(logger),
    private cache: ICache<Jwk[]> = new InMemoryCache<Jwk[]>(logger),
    private cacheTtl: number = 3600000, // 1 hour default
  ) {
    this.validateJwksUri();
  }

  /**
   * Retrieves a JSON Web Key (JWK) by its Key ID (kid).
   *
   * This method first attempts to retrieve the JWK from the cache. If the key is not
   * found or the cache is empty, it refreshes the cache by fetching the JWKS from the URI.
   *
   * @param {string} kid - The Key ID to search for.
   * @returns {Promise<Jwk>} The corresponding JWK.
   * @throws {ClientError} If the `kid` is invalid or the key is not found.
   * @example
   * ```typescript
   * const jwk = await jwksClient.getKey('myKid');
   * console.log(jwk);
   * ```
   */
  public async getKey(kid: string): Promise<Jwk> {
    if (!kid) {
      throw new ClientError('kid must be provided', 'INVALID_KID');
    }

    let jwks = this.cache.get(this.cacheKey);
    if (jwks) {
      this.logger.debug(`Cache hit for key: ${this.cacheKey}`);
    } else {
      await this.ensureJWKS();
      jwks = this.cache.get(this.cacheKey);
      if (!jwks) {
        throw new ClientError(
          'JWKS cache is empty after refresh',
          'JWKS_FETCH_ERROR',
        );
      }
    }

    let key = this.findKey(jwks, kid);
    if (!key) {
      this.logger.warn(`Key with kid ${kid} not found. Refreshing JWKS.`);
      await this.ensureJWKS();
      jwks = this.cache.get(this.cacheKey);
      key = this.findKey(jwks, kid);
      if (!key) {
        throw new ClientError(
          `No matching key found for kid ${kid}`,
          'JWKS_KEY_NOT_FOUND',
        );
      }
    }
    return key;
  }

  /**
   * Ensures that JWKS is fetched and cached, preventing concurrent fetches.
   *
   * If a fetch is already in progress, it returns the existing fetch promise.
   *
   * @private
   * @returns {Promise<void>} Resolves when the JWKS has been fetched and cached.
   */
  private async ensureJWKS(): Promise<void> {
    if (this.fetchingJWKS === null) {
      this.fetchingJWKS = this.refreshCache().finally(() => {
        this.fetchingJWKS = null;
      });
    }
    return this.fetchingJWKS;
  }

  /**
   * Finds a JWK by its Key ID (kid) within a JWKS array.
   *
   * @private
   * @param {Jwk[]} jwks - The array of JWKs.
   * @param {string} kid - The Key ID to search for.
   * @returns {Jwk | undefined} The matching JWK or `undefined` if not found.
   */
  private findKey(jwks: Jwk[], kid: string): Jwk | undefined {
    return jwks.find((k) => k.kid === kid);
  }

  /**
   * Refreshes the JWKS cache by fetching from the JWKS URI.
   *
   * This method fetches the JWKS from the URI, validates its structure,
   * and stores it in the cache with the specified TTL.
   *
   * @public
   * @returns {Promise<void>} Resolves when the cache is refreshed.
   * @throws {ClientError} If fetching or parsing fails.
   */
  public async refreshCache(): Promise<void> {
    try {
      this.logger.debug('Fetching JWKS from URI', { jwksUri: this.jwksUri });
      const response = await this.httpClient.get(this.jwksUri);

      let jwks: JwksResponse;
      try {
        jwks = JSON.parse(response);
      } catch (parseError) {
        this.logger.error('Failed to parse JWKS response', { parseError });
        throw new ClientError(
          'Invalid JWKS response format',
          'JWKS_PARSE_ERROR',
        );
      }

      this.validateJwks(jwks);
      this.cache.set(this.cacheKey, jwks.keys, this.cacheTtl);
      this.logger.debug('JWKS cache refreshed', {
        numberOfKeys: jwks.keys.length,
      });
    } catch (error) {
      this.handleFetchError(error);
    }
  }

  /**
   * Validates the JWKS URI to ensure it is a valid string.
   *
   * @private
   * @throws {ClientError} If the JWKS URI is invalid.
   */
  private validateJwksUri(): void {
    if (!this.jwksUri || typeof this.jwksUri !== 'string') {
      throw new ClientError('Invalid JWKS URI provided', 'INVALID_JWKS_URI');
    }
  }

  /**
   * Validates the structure of the JWKS response.
   *
   * @private
   * @param {JwksResponse} jwks - The JWKS response to validate.
   * @throws {ClientError} If the JWKS structure is invalid.
   */
  private validateJwks(jwks: JwksResponse): void {
    if (!jwks.keys || !Array.isArray(jwks.keys)) {
      this.logger.error('JWKS response does not contain keys array', {
        jwks,
      });
      throw new ClientError(
        'JWKS response does not contain keys',
        'JWKS_INVALID',
      );
    }
  }

  /**
   * Handles errors that occur during JWKS fetching.
   *
   * Logs the error and rethrows it as a `ClientError` with appropriate messaging.
   *
   * @private
   * @param {unknown} error - The error to handle.
   * @throws {ClientError} Always throws a `ClientError` for consistent error handling.
   */
  private handleFetchError(error: unknown): never {
    if (error instanceof ClientError) {
      throw error;
    }
    this.logger.error('Failed to fetch JWKS', { error });
    throw new ClientError('Failed to fetch JWKS', 'JWKS_FETCH_ERROR');
  }
}
