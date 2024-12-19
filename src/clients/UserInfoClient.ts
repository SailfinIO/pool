// src/clients/UserInfoClient.ts

import { TokenManager } from '../token/TokenManager';
import { IDiscoveryConfig } from '../interfaces/IDiscoveryConfig';
import { IUserInfo } from '../interfaces/IUserInfo';
import { ClientError } from '../errors/ClientError';
import { HTTPClient } from '../utils/HTTPClient';
import { Logger } from '../utils/Logger';

export class UserInfoClient {
  private tokenManager: TokenManager;
  private discoveryConfig: IDiscoveryConfig;
  private logger: Logger;
  private httpClient: HTTPClient;

  constructor(
    tokenManager: TokenManager,
    discoveryConfig: IDiscoveryConfig,
    logger: Logger,
  ) {
    this.tokenManager = tokenManager;
    this.discoveryConfig = discoveryConfig;
    this.logger = logger;
    this.httpClient = new HTTPClient(this.logger);
  }

  public async getUserInfo(): Promise<IUserInfo> {
    const accessToken = await this.tokenManager.getAccessToken();
    if (!accessToken) {
      throw new ClientError(
        'No valid access token available',
        'NO_ACCESS_TOKEN',
      );
    }

    const userInfoEndpoint = this.discoveryConfig.userinfo_endpoint;
    const headers = {
      Authorization: `Bearer ${accessToken}`,
    };

    try {
      const response = await this.httpClient.get(
        userInfoEndpoint,
        JSON.stringify(headers),
      );
      const userInfo: IUserInfo = JSON.parse(response);
      this.logger.debug('Fetched user info successfully', { userInfo });
      return userInfo;
    } catch (error) {
      this.logger.error('Failed to fetch user info', error);
      throw new ClientError('User info retrieval failed', 'USERINFO_ERROR', {
        originalError: error,
      });
    }
  }
}