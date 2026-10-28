import { config } from "../../config.js";

/**
 * Shape of a listing pushed to the GreenRev marketplace (greenrevs.com).
 * This is the contract the marketplace team implements; see docs/INTEGRATION.md.
 */
export interface MarketplaceListing {
  externalId: string;          // inventory item id in the Business Suite
  sellerId: string | null;     // GreenRev marketplace seller id for this organisation
  seller: { name: string; phone: string | null; whatsapp: string | null; city: string | null; state: string | null; logoUrl: string | null };
  type: "vehicle" | "part" | "accessory";
  title: string;
  description: string | null;
  priceNgn: number;            // kobo
  currency: "NGN";
  status: "available" | "in_transit" | "reserved";
  photos: string[];
  vehicle?: {
    make: string | null; model: string | null; year: number | null; trim: string | null; bodyType: string | null; color: string | null;
    mileageKm: number | null; fuelType: string | null; transmission: string | null; engine: string | null; condition: string | null;
    vinLast6: string | null;
  };
  part?: { partNumber: string | null; brand: string | null; compatibleWith: string[]; condition: string | null; quantityAvailable: number };
  attributes: Record<string, unknown>;
  updatedAt: string;
}

export interface MarketplaceAdapter {
  upsert(listing: MarketplaceListing, existingListingId: string | null): Promise<{ listingId: string; url?: string }>;
  unpublish(listingId: string): Promise<void>;
}

/** Talks to the marketplace's REST API. */
export class HttpMarketplaceAdapter implements MarketplaceAdapter {
  constructor(private baseUrl: string, private apiKey: string) {}

  private async request(method: string, path: string, body?: unknown) {
    const res = await fetch(`${this.baseUrl.replace(/\/$/, "")}${path}`, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 404 && method === "DELETE") return null;
    if (!res.ok) throw new Error(`Marketplace ${method} ${path} failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
    return res.status === 204 ? null : res.json();
  }

  async upsert(listing: MarketplaceListing, existingListingId: string | null) {
    const data: any = existingListingId
      ? await this.request("PUT", `/v1/listings/${encodeURIComponent(existingListingId)}`, listing)
      : await this.request("POST", `/v1/listings`, listing);
    return { listingId: String(data?.id ?? existingListingId), url: data?.url };
  }

  async unpublish(listingId: string) {
    await this.request("DELETE", `/v1/listings/${encodeURIComponent(listingId)}`);
  }
}

/** Used when no marketplace URL is configured (local dev, tests): records intent only. */
export class LogMarketplaceAdapter implements MarketplaceAdapter {
  public calls: Array<{ op: string; listing?: MarketplaceListing; listingId?: string | null }> = [];
  async upsert(listing: MarketplaceListing, existingListingId: string | null) {
    this.calls.push({ op: "upsert", listing, listingId: existingListingId });
    return { listingId: existingListingId ?? `local-${listing.externalId}` };
  }
  async unpublish(listingId: string) {
    this.calls.push({ op: "unpublish", listingId });
  }
}

let adapter: MarketplaceAdapter | null = null;

export function getMarketplaceAdapter(): MarketplaceAdapter {
  adapter ??= config.greenrev.marketplaceUrl
    ? new HttpMarketplaceAdapter(config.greenrev.marketplaceUrl, config.greenrev.marketplaceApiKey)
    : new LogMarketplaceAdapter();
  return adapter;
}

export function setMarketplaceAdapter(a: MarketplaceAdapter): void {
  adapter = a;
}
