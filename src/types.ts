export interface NormalizedSearchResult {
  title: string;
  snippet: string | null;
  url: string;
  table: string;
  contentTypeLabel: string;
  score: number;
}

export interface NormalizedSearchResponse {
  query: string;
  searchedQuery: string;
  detectedContentType: string | null;
  totalResults: number;
  results: NormalizedSearchResult[];
  contentTypeFilters: Array<{ label: string; count: number }>;
  contentTypeFilterDegraded: boolean;
  // True when more results exist beyond offset + limit (i.e. offset + limit < totalResults).
  hasMore: boolean;
  note: string | null;
}

export interface SearchParams {
  query: string;
  contentType?: string;
  limit: number;
  offset: number;
}
