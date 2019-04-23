import _ from "lodash";
import { each } from "lodash-es";

// API interfaces
export interface IResultFormat {
  text: string;
  value: string;
}

export interface IDataTarget {
  target: string;
  datapoints: any[];
  refId: string;
  query: any;
}

export default class ResponseParser {
  public static parseProjects(results): IResultFormat[] {
    return ResponseParser.parseData(results, "id", "id");
  }

  public static parseDatasets(results): IResultFormat[] {
    return ResponseParser.parseData(
      results,
      "datasetReference.datasetId",
      "datasetReference.datasetId"
    );
  }

  public static parseTableFields(results, filter): IResultFormat[] {
    const fields: IResultFormat[] = [];
    if (!results || results.length === 0) {
      return fields;
    }
    const res = [];
    results = ResponseParser._handleRecordFields(results, res);
    for (const fl of results) {
      if (filter.length > 0) {
        for (const flt of filter) {
          if (flt === fl.type) {
            fields.push({
              text: fl.name,
              value: fl.type
            });
          }
        }
      } else {
        fields.push({
          text: fl.name,
          value: fl.type
        });
      }
    }
    return fields;
  }

  public static parseDataQuery(results, format) {
    if (!results.rows) {
      return { data: [] };
    }
    if (format === "time_series") {
      return ResponseParser._toTimeSeries(results);
    } else {
      return ResponseParser._toTable(results);
    }
  }

  public static _convertValues(v, type) {
    if (
      ["INT64", "NUMERIC", "FLOAT64", "FLOAT", "INT", "INTEGER"].includes(type)
    ) {
      return Number(v);
    }
    if (["DATE", "DATETIME", "TIMESTAMP"].includes(type)) {
      return new Date(Number(v) * 1000).toString();
    }
    return v;
  }

  private static parseData(results, text, value): IResultFormat[] {
    const data: IResultFormat[] = [];
    if (!results || results.length === 0) {
      return data;
    }
    const objectTextList = text.split(".");
    const objectValueList = value.split(".");
    let itemValue;
    let itemText;
    for (let item of results) {
      item = ResponseParser.manipulateItem(item);
      itemText = item[objectTextList[0]];
      itemValue = item[objectValueList[0]];
      for (let i = 1; i < objectTextList.length; i++) {
        itemText = itemText[objectTextList[i]];
      }
      for (let i = 1; i < objectValueList.length; i++) {
        itemValue = itemValue[objectValueList[i]];
      }

      data.push({ text: itemText, value: itemValue });
    }
    return data;
  }

  private static manipulateItem(item) {
    if (item.kind === "bigquery#table") {
      if (item.timePartitioning) {
        item.tableReference.tableId =
          item.tableReference.tableId + "__partitioned";
        if (item.timePartitioning.field) {
          item.tableReference.tableId += "__" + item.timePartitioning.field;
        }
      }
    }
    return item;
  }

  private static _handleRecordFields(results, res) {
    for (const fl of results) {
      if (fl.type === "RECORD") {
        for (const f of fl.fields) {
          if (f.type !== "RECORD") {
            res.push({ name: fl.name + "." + f.name, type: f.type });
          } else {
            for (const ff of f.fields) {
              ff.name = fl.name + "." + f.name + "." + ff.name;
            }
            res = ResponseParser._handleRecordFields(f.fields, res);
          }
        }
      } else {
        res.push({ name: fl.name, type: fl.type });
      }
    }
    return res;
  }

  private static _toTimeSeries(results) {
    let timeIndex = -1;
    let metricIndex = -1;
    let valueIndex = -1;
    for (let i = 0; i < results.schema.fields.length; i++) {
      if (
        timeIndex === -1 &&
        ["DATE", "TIMESTAMP", "DATETIME"].includes(
          results.schema.fields[i].type
        )
      ) {
        timeIndex = i;
      }
      if (metricIndex === -1 && results.schema.fields[i].name === "metric") {
        metricIndex = i;
      }
      if (
        valueIndex === -1 &&
        ["INT64", "NUMERIC", "FLOAT64", "FLOAT", "INT", "INTEGER"].includes(
          results.schema.fields[i].type
        )
      ) {
        valueIndex = i;
      }
    }
    if (timeIndex === -1) {
      throw new Error(
        "No datetime column found in the result. The Time Series format requires a time column."
      );
    }
    return ResponseParser._buildDataPoints(
      results,
      timeIndex,
      metricIndex,
      valueIndex
    );
  }

  private static _buildDataPoints(results, timeIndex, metricIndex, valueIndex) {
    const data = [];
    let metricName = "";
    for (const row of results.rows) {
      if (row) {
        const epoch = Number(row.f[timeIndex].v) * 1000;
        metricName =
          metricIndex > -1
            ? row.f[metricIndex].v
            : results.schema.fields[valueIndex].name;
        const bucket = ResponseParser.findOrCreateBucket(data, metricName);
        bucket.datapoints.push([Number(row.f[valueIndex].v), epoch]);
      }
    }
    return data;
  }

  private static findOrCreateBucket(data, target): IDataTarget {
    let dataTarget = _.find(data, ["target", target]);
    if (!dataTarget) {
      dataTarget = { target, datapoints: [], refId: "", query: "" };
      data.push(dataTarget);
    }

    return dataTarget;
  }

  private static _toTable(results) {
    const columns = [];
    for (const fl of results.schema.fields) {
      columns.push({
        text: fl.name,
        type: fl.type
      });
    }
    const rows = [];
    each(results.rows, ser => {
      const r = [];
      each(ser, v => {
        for (let i = 0; i < v.length; i++) {
          const val = ResponseParser._convertValues(v[i].v, columns[i].type);
          r.push(val);
        }
      });
      rows.push(r);
    });
    return {
      columns,
      rows,
      type: "table"
    };
  }

  constructor(private $q) {}

  public parseTabels(results): IResultFormat[] {
    return this._handelWildCardTables(
      ResponseParser.parseData(
        results,
        "tableReference.tableId",
        "tableReference.tableId"
      )
    );
  }

  public transformAnnotationResponse(options, data) {
    const table = data.data.results[options.annotation.name].tables[0];
    let timeColumnIndex = -1;
    const titleColumnIndex = -1;
    let textColumnIndex = -1;
    let tagsColumnIndex = -1;

    for (let i = 0; i < table.columns.length; i++) {
      if (table.columns[i].text === "time") {
        timeColumnIndex = i;
      } else if (table.columns[i].text === "text") {
        textColumnIndex = i;
      } else if (table.columns[i].text === "tags") {
        tagsColumnIndex = i;
      }
    }
    if (timeColumnIndex === -1) {
      return this.$q.reject({
        message: "Missing mandatory time column in annotation query."
      });
    }
    const list = [];
    for (const row of table.rows) {
      list.push({
        annotation: options.annotation,
        tags: row[tagsColumnIndex]
          ? row[tagsColumnIndex].trim().split(/\s*,\s*/)
          : [],
        text: row[textColumnIndex],
        time: Math.floor(row[timeColumnIndex]),
        title: row[titleColumnIndex]
      });
    }
    return list;
  }

  private _handelWildCardTables(tables) {
    let sorted = new Map();
    let newTables = [];
    for (const t of tables) {
      const partitioned = t.text.indexOf("__partitioned");
      if (partitioned > -1) {
        t.text = t.text.substring(0, partitioned);
      }
      if (
        !t.value.match(
          /_(?:(?:20\d{2})(?:(?:(?:0[13578]|1[02])31)|(?:(?:0[1,3-9]|1[0-2])(?:29|30)))|(?:(?:20(?:0[48]|[2468][048]|[13579][26]))0229)|(?:20\d{2})(?:(?:0?[1-9])|(?:1[0-2]))(?:0?[1-9]|1\d|2[0-8]))(?!\d)$/g
        )
      ) {
        sorted = sorted.set(t.value, t.text);
      } else {
        sorted.set(
          t.text.substring(0, t.text.length - 8) + "YYYYMMDD",
          t.text.substring(0, t.text.length - 8) + "YYYYMMDD"
        );
      }
    }
    sorted.forEach((text, value) => {
      newTables = newTables.concat({ text, value });
    });
    return newTables;
  }
}
