import {
  clearFavorites,
  createEmptyFavorites,
  deleteCollection,
  openCollection,
  saveCollection,
  saveTour
} from "../src/favorites.js";
import { assert } from "./helpers/assert.js";
import { test } from "./helpers/runner.js";

const sampleTour = (id: number) => ({ hotel_id: id, hotel_name: `Hotel ${id}`, country_name: "Turkey", price: 100000 + id });

test("saveCollection adds to session.favorites.collections", () => {
  const fav = createEmptyFavorites();
  const saved = saveCollection(fav, {
    id: "1",
    paramsSnapshot: { country: "Турция", nights: 7, budgetMax: 120000 },
    tours: [sampleTour(1), sampleTour(2)]
  });
  assert(saved.favorites.collections.length === 1, "collection should be added");
  assert(saved.collection.tours.length === 2, "collection tours should be stored");
});

test("saveTour prevents duplicates", () => {
  let fav = createEmptyFavorites();
  let res = saveTour(fav, sampleTour(10));
  fav = res.favorites;
  assert(res.added, "first save should add");
  res = saveTour(fav, sampleTour(10));
  assert(!res.added, "second save should not duplicate");
  assert(res.favorites.tours.length === 1, "favorites tours should stay deduped");
});

test("openCollection returns saved tours", () => {
  const saved = saveCollection(createEmptyFavorites(), {
    id: "abc",
    paramsSnapshot: { country: "ОАЭ", nights: 7, budgetMin: 90000, budgetMax: 120000 },
    tours: [sampleTour(3), sampleTour(4)]
  });
  const opened = openCollection(saved.favorites, "abc");
  assert(opened !== undefined, "collection should open");
  assert((opened?.tours.length ?? 0) === 2, "opened collection should contain tours");
});

test("deleteCollection removes correct entry", () => {
  let fav = saveCollection(createEmptyFavorites(), {
    id: "1",
    paramsSnapshot: { country: "Турция", nights: 7 },
    tours: [sampleTour(1)]
  }).favorites;
  fav = saveCollection(fav, {
    id: "2",
    paramsSnapshot: { country: "Египет", nights: 10 },
    tours: [sampleTour(2)]
  }).favorites;
  const res = deleteCollection(fav, "1");
  assert(res.removed, "collection should be removed");
  assert(res.favorites.collections.length === 1, "one collection should remain");
  assert(res.favorites.collections[0]?.id === "2", "correct collection should remain");
});

test("clearFavorites empties structure", () => {
  let fav = createEmptyFavorites();
  fav = saveTour(fav, sampleTour(20)).favorites;
  fav = saveCollection(fav, {
    id: "z",
    paramsSnapshot: { country: "Мальдивы", nights: 10, budgetMax: 150000 },
    tours: [sampleTour(21)]
  }).favorites;
  const cleared = clearFavorites();
  assert(cleared.tours.length === 0, "tours should be empty");
  assert(cleared.collections.length === 0, "collections should be empty");
});
