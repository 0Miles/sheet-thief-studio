Median / p95 in milliseconds, 50 runs per row, 120 ms of rest between edits (headed).

| strategy | shown | bar | docToJson | projection | finish() | render → rendered | total |
|---|---|---|---|---|---|---|---|
| replace+hint, 16 bars | one | 3 | 1.6 / 2.9 | 0.3 / 0.4 | 0.0 / 0.1 | 19.6 / 26.7 | 21.7 / 28.7 |
| replace+hint, 16 bars | one | 50 | 1.5 / 2.4 | 0.3 / 0.4 | 0.0 / 0.1 | 17.4 / 26.9 | 19.3 / 29.0 |
| replace+hint, 16 bars | one | 98 | 1.8 / 2.4 | 0.2 / 0.4 | 0.0 / 0.1 | 17.3 / 25.0 | 19.4 / 27.6 |
| replace+hint, 16 bars | five | 3 | 1.6 / 2.2 | 0.2 / 0.4 | 0.0 / 0.2 | 23.6 / 31.5 | 25.8 / 33.3 |
| replace+hint, 16 bars | five | 50 | 1.6 / 2.4 | 0.2 / 0.4 | 0.0 / 0.1 | 20.4 / 27.8 | 22.4 / 30.3 |
| replace+hint, 16 bars | five | 98 | 1.6 / 2.3 | 0.2 / 0.4 | 0.0 / 0.1 | 19.1 / 25.0 | 21.1 / 27.0 |
| replace+hint, 16 bars, no worker | one | 3 | 1.5 / 2.3 | 0.2 / 0.3 | 0.0 / 0.2 | 1.5 / 2.7 | 3.3 / 5.2 |
| replace+hint, 16 bars, no worker | one | 50 | 1.6 / 2.4 | 0.2 / 0.3 | 0.0 / 0.1 | 0.8 / 1.2 | 2.7 / 4.0 |
| replace+hint, 16 bars, no worker | one | 98 | 1.6 / 2.7 | 0.3 / 0.4 | 0.0 / 0.2 | 0.7 / 1.1 | 2.6 / 4.1 |
| replace+hint, 16 bars, no worker | five | 3 | 1.6 / 2.5 | 0.2 / 0.3 | 0.0 / 0.1 | 5.4 / 8.6 | 7.4 / 10.6 |
| replace+hint, 16 bars, no worker | five | 50 | 1.7 / 2.6 | 0.2 / 0.4 | 0.0 / 0.1 | 3.4 / 5.1 | 5.5 / 7.9 |
| replace+hint, 16 bars, no worker | five | 98 | 1.8 / 2.5 | 0.2 / 0.3 | 0.0 / 0.1 | 1.4 / 2.2 | 3.5 / 4.5 |
