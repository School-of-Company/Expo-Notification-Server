import { Injectable } from '@nestjs/common';
import {
  guardDownstream,
  isTimeoutError,
  type DownstreamFailure,
} from '../common/resilience';

export interface DiscordEmbedField {
  name: string;
  value: string;
}

export interface DiscordEmbed {
  description: string;
  color: number;
  fields: DiscordEmbedField[];
}

export class DiscordDeliveryError extends Error implements DownstreamFailure {
  constructor(
    message: string,
    readonly status?: number,
    readonly timedOut = false,
  ) {
    super(message);
  }
}

const MAX_EMBEDS_PER_REQUEST = 10;
const REQUEST_TIMEOUT_MS = 10_000;

@Injectable()
export class DiscordProvider {
  async sendEmbeds(webhookUrl: string, embeds: DiscordEmbed[]): Promise<void> {
    for (let i = 0; i < embeds.length; i += MAX_EMBEDS_PER_REQUEST) {
      await this.post(webhookUrl, embeds.slice(i, i + MAX_EMBEDS_PER_REQUEST));
    }
  }

  // 발송은 재시도하지 않는다(같은 리포트가 두 번 올라갈 수 있다). 실패하면 saveLastSent가 안 돼 다음 정시 실행이 다시 보낸다.
  private async post(
    webhookUrl: string,
    embeds: DiscordEmbed[],
  ): Promise<void> {
    return guardDownstream(
      'discord',
      false,
      () => this.attempt(webhookUrl, embeds),
      () => new DiscordDeliveryError('discord circuit open'),
    );
  }

  private async attempt(
    webhookUrl: string,
    embeds: DiscordEmbed[],
  ): Promise<void> {
    let response: Response;
    try {
      response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: '', embeds }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new DiscordDeliveryError(
        'discord webhook unreachable',
        undefined,
        isTimeoutError(error),
      );
    }
    if (!response.ok) {
      throw new DiscordDeliveryError(
        `discord webhook responded ${response.status}`,
        response.status,
      );
    }
  }
}
