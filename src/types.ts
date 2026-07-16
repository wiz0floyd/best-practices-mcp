export interface NormalizedSearchResult {
  title: string;
  snippet: string | null;
  url: string;
  table: string;
  contentTypeLabel: string;
}

export interface NormalizedSearchResponse {
  query: string;
  totalResults: number | null;
  results: NormalizedSearchResult[];
  warnings: string[];
}

export interface SearchParams {
  query: string;
  contentType?: string;
  limit: number;
  offset: number;
}
