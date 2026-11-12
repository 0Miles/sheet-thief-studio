Median / p95 in milliseconds, 50 runs per row, 120 ms of rest between edits (headless).

| strategy | shown | bar | docToJson | projection | finish() | render → rendered | total |
|---|---|---|---|---|---|---|---|
| replace+hint, 16 bars | one | 3 | 1.8 / 2.8 | 0.3 / 0.4 | 0.0 / 0.1 | 19.1 / 27.4 | 21.5 / 29.9 |
| replace+hint, 16 bars | one | 50 | 1.6 / 2.2 | 0.3 / 0.4 | 0.0 / 0.1 | 18.1 / 26.4 | 20.1 / 28.7 |
| replace+hint, 16 bars | one | 98 | 1.8 / 2.9 | 0.3 / 0.4 | 0.0 / 0.1 | 18.3 / 29.8 | 20.8 / 32.7 |
| replace+hint, 16 bars | five | 3 | 1.8 / 3.3 | 0.3 / 0.4 | 0.0 / 0.1 | 26.3 / 41.3 | 28.2 / 45.3 |
| replace+hint, 16 bars | five | 50 | 1.9 / 3.4 | 0.3 / 0.5 | 0.0 / 0.1 | 24.8 / 41.8 | 27.2 / 44.8 |
| replace+hint, 16 bars | five | 98 | 2.0 / 3.5 | 0.3 / 0.5 | 0.0 / 0.1 | 22.3 / 35.6 | 25.4 / 39.5 |
| replace+hint, 16 bars, no worker | one | 3 | 1.9 / 3.0 | 0.3 / 0.4 | 0.0 / 0.1 | 1.8 / 3.4 | 4.0 / 6.5 |
| replace+hint, 16 bars, no worker | one | 50 | 1.8 / 2.6 | 0.2 / 0.5 | 0.0 / 0.1 | 0.9 / 1.4 | 2.9 / 4.0 |
| replace+hint, 16 bars, no worker | one | 98 | 1.6 / 2.7 | 0.3 / 0.4 | 0.0 / 0.1 | 0.6 / 0.9 | 2.6 / 4.1 |
| replace+hint, 16 bars, no worker | five | 3 | 1.7 / 2.7 | 0.2 / 0.5 | 0.0 / 0.1 | 5.5 / 9.4 | 7.5 / 11.5 |
| replace+hint, 16 bars, no worker | five | 50 | 1.8 / 2.7 | 0.3 / 0.4 | 0.0 / 0.1 | 3.3 / 5.2 | 5.4 / 7.5 |
| replace+hint, 16 bars, no worker | five | 98 | 1.7 / 2.2 | 0.3 / 0.4 | 0.0 / 0.1 | 1.3 / 2.0 | 3.3 / 4.7 |
