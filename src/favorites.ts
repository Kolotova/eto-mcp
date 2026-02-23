export type FavoriteTour = {
  hotel_id: number;
  hotel_name?: string;
  country_name?: string;
  city_name?: string;
  date_from?: string;
  nights?: number;
  price?: number;
  currency?: string;
  meal?: string;
  room?: string;
  operator?: string;
  image_url?: string;
  [key: string]: unknown;
};

export type SavedSet = {
  id: string;
  createdAt: Date;
  paramsSnapshot: {
    country: string;
    nights: number;
    budgetMin?: number;
    budgetMax?: number;
    meal?: string;
  };
  tours: FavoriteTour[];
};

export type FavoritesStore = {
  tours: FavoriteTour[];
  collections: SavedSet[];
};

export function createEmptyFavorites(): FavoritesStore {
  return { tours: [], collections: [] };
}

export function saveTour(favorites: FavoritesStore, tour: FavoriteTour): { favorites: FavoritesStore; added: boolean } {
  const hotelId = Number(tour.hotel_id);
  const exists = favorites.tours.some((t) => Number(t.hotel_id) === hotelId);
  if (exists) {
    return { favorites, added: false };
  }
  return {
    favorites: {
      ...favorites,
      tours: [...favorites.tours, tour]
    },
    added: true
  };
}

export function saveCollection(
  favorites: FavoritesStore,
  input: {
    id: string;
    createdAt?: Date;
    paramsSnapshot: SavedSet["paramsSnapshot"];
    tours: FavoriteTour[];
    maxTours?: number;
  }
): { favorites: FavoritesStore; collection: SavedSet } {
  const maxTours = input.maxTours ?? 10;
  const collection: SavedSet = {
    id: input.id,
    createdAt: input.createdAt ?? new Date(),
    paramsSnapshot: input.paramsSnapshot,
    tours: input.tours.slice(0, Math.max(1, maxTours))
  };
  return {
    favorites: {
      ...favorites,
      collections: [...favorites.collections, collection]
    },
    collection
  };
}

export function openCollection(favorites: FavoritesStore, id: string): SavedSet | undefined {
  return favorites.collections.find((c) => c.id === id);
}

export function deleteCollection(favorites: FavoritesStore, id: string): { favorites: FavoritesStore; removed: boolean } {
  const next = favorites.collections.filter((c) => c.id !== id);
  if (next.length === favorites.collections.length) {
    return { favorites, removed: false };
  }
  return {
    favorites: {
      ...favorites,
      collections: next
    },
    removed: true
  };
}

export function clearFavorites(): FavoritesStore {
  return createEmptyFavorites();
}
