import { Injectable } from '@nestjs/common';

export interface DiscordEmbedField {
  name: string;
  value: string;
}

export interface DiscordEmbed {
  description: string;
  color: number;
  fields: DiscordEmbedField[];
}

export class DiscordDeliveryError extends Error {}

const MAX_EMBEDS_PER_REQUEST = 10;
const REQUEST_TIMEOUT_MS = 10_000;

@Injectable()
export class DiscordProvider {
  async sendEmbeds(webhookUrl: string, embeds: DiscordEmbed[]): Promise<void> {
    for (let i = 0; i < embeds.length; i += MAX_EMBEDS_PER_REQUEST) {
      await this.post(webhookUrl, embeds.slice(i, i + MAX_EMBEDS_PER_REQUEST));
    }
  }

  private async post(
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
    } catch {
      throw new DiscordDeliveryError('discord webhook unreachable');
    }
    if (!response.ok) {
      throw new DiscordDeliveryError(
        `discord webhook responded ${response.status}`,
      );
    }
  }
}
