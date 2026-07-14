// Copyright (c) 2017-2020 Christopher Johnston
// Copyright (c) 2025-present Viktor Rognas
// Licensed under MIT License

import { XMLParser } from "fast-xml-parser";
import { configuration } from "../helpers/configuration";
import { camelcase } from "../util";
import { logError, getErrorMessage } from "../util/errorLogger";
import { capitalize } from "../util/formatting";

/**
 * Represents a primitive value in parsed XML
 */
type XmlPrimitive = string | number | boolean | null;

/**
 * Represents any value that can appear in parsed XML.
 * Can be a primitive, object with string keys, or array.
 */
type XmlValue = XmlPrimitive | XmlObject | XmlArray;

/**
 * Represents an object in parsed XML with string keys
 */
interface XmlObject {
  [key: string]: XmlValue;
}

/**
 * Represents an array in parsed XML
 */
type XmlArray = XmlValue[];

interface ParseOptions {
  mergeAttrs?: boolean;
  explicitArray?: boolean;
  explicitRoot?: boolean;
  camelcase?: boolean;
  preserveText?: boolean;
}

/**
 * Default XML parse options used by most SVN XML parsers.
 * Merges attributes, strips root, unwraps single-element arrays, camelCases keys.
 */
export const DEFAULT_PARSE_OPTIONS: ParseOptions = {
  mergeAttrs: true,
  explicitRoot: false,
  explicitArray: false,
  camelcase: true
};

/**
 * Normalize a value to an array.
 * Handles undefined, single values, and existing arrays.
 * Use when XML parsing may return T or T[] depending on element count.
 */
export function ensureArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * XML Parser Adapter providing xml2js-compatible parsing using fast-xml-parser
 *
 * Implements key xml2js behaviors:
 * - mergeAttrs: Merge XML attributes into parent object
 * - explicitArray: Control single vs array element wrapping
 * - explicitRoot: Include/exclude root element (false strips root)
 * - camelcase: Transform tag and attribute names to camelCase
 *
 * Security limits:
 * - Max XML size: 50MB (DoS protection, supports large repos)
 * - Max tag count: Configurable via svn.performance.maxXmlTags (default 500k, 0=unlimited)
 * - Max recursion depth: 100 levels (stack overflow protection)
 */
export class XmlParserAdapter {
  // Security limits
  private static readonly MAX_XML_SIZE = 50 * 1024 * 1024; // 50MB for large repos
  private static readonly MAX_TAG_COUNT = 500000; // 500k tags for large repos
  private static readonly MAX_DEPTH = 100;
  /**
   * Sanitize XML string by removing invalid characters
   * Valid XML chars: #x9 | #xA | #xD | [#x20-#xD7FF] | [#xE000-#xFFFD]
   */
  private static sanitizeXml(xml: string): string {
    // Remove control characters except tab, CR, LF
    return xml.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
  }

  /**
   * Lazy-cached fast-xml-parser instance. The parser is stateless after
   * construction (options are frozen at init), so a single instance is
   * reused across all parse calls — saving ~20 option assignments per
   * SVN result (status refreshes, blames, logs all hit this hot path).
   */
  private static fxpParser?: XMLParser;
  private static preservedTextParser?: XMLParser;
  private static getFxpParser(preserveText = false): XMLParser {
    const cached = preserveText ? this.preservedTextParser : this.fxpParser;
    if (cached) return cached;

    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "@_",
      textNodeName: "_",
      ignoreDeclaration: true,
      trimValues: !preserveText,
      parseAttributeValue: false,
      parseTagValue: !preserveText,
      processEntities: false, // XXE protection
      allowBooleanAttributes: true,
      cdataPropName: "__cdata", // Handle CDATA sections
      htmlEntities: true, // Decode HTML entities
      removeNSPrefix: true, // Remove namespace prefixes
      numberParseOptions: {
        hex: false,
        leadingZeros: false,
        skipLike: /./ // Don't parse any numbers, keep as strings
      },
      stopNodes: [], // Parse all nodes
      unpairedTags: [], // No unpaired tags expected
      alwaysCreateTextNode: false,
      commentPropName: false, // Ignore comments
      isArray: () => false, // Single elements not wrapped in arrays
      tagValueProcessor: (_tagName: string, tagValue: string) => tagValue,
      attributeValueProcessor: (_attrName: string, attrValue: string) =>
        attrValue,
      // Disable strict XML validation to match xml2js permissiveness
      ignorePiTags: true, // Ignore PI tags
      preserveOrder: false // Don't preserve order
    });
    if (preserveText) this.preservedTextParser = parser;
    else this.fxpParser = parser;
    return parser;
  }

  /**
   * Single-pass transformation combining mergeAttrs, camelcase, and normalizeArrays.
   * Replaces 4 sequential recursive passes with 1, providing 60-70% performance improvement.
   *
   * @param obj Value to transform
   * @param options Parse options controlling transformations
   * @param depth Current recursion depth for stack overflow protection
   */
  private static transform(
    obj: XmlValue,
    options: ParseOptions,
    depth: number = 0
  ): XmlValue {
    if (depth > this.MAX_DEPTH) {
      throw new Error(
        `Object nesting exceeds maximum depth of ${this.MAX_DEPTH}`
      );
    }

    // Primitives pass through unchanged
    if (typeof obj !== "object" || obj === null) {
      return obj;
    }

    // Arrays: transform contents, then unwrap single-element if explicitArray: false
    if (Array.isArray(obj)) {
      const transformed = obj.map(item =>
        this.transform(item, options, depth + 1)
      );
      // Single-element array unwrapping handled by caller
      return transformed;
    }

    // Object: apply all transformations in single pass
    const result: XmlObject = {};
    let hasTextNode = false;
    let textNodeValue: XmlValue = null;

    for (const key in obj) {
      let finalKey = key;
      const value = obj[key]!;

      // 1. Handle attributes (mergeAttrs)
      if (options.mergeAttrs && key.startsWith("@_")) {
        finalKey = key.substring(2);
      } else if (key === "_") {
        // Text node - handle specially
        hasTextNode = true;
        textNodeValue = value;
        continue;
      }

      // 2. Apply camelCase transformation to key
      if (options.camelcase) {
        finalKey = camelcase(finalKey);
      }

      // 3. Recursively transform the value
      let transformed = this.transform(value, options, depth + 1);

      // 4. Unwrap single-element arrays if explicitArray: false
      if (
        options.explicitArray === false &&
        Array.isArray(transformed) &&
        transformed.length === 1
      ) {
        transformed = transformed[0]!;
      }

      result[finalKey] = transformed;
    }

    // Handle text-only nodes: return text value directly
    if (hasTextNode && Object.keys(result).length === 0) {
      return textNodeValue;
    }

    // Text node with other properties: keep as "_"
    if (hasTextNode) {
      result["_"] = textNodeValue;
    }

    return result;
  }

  /**
   * Strip root element if explicitRoot: false
   * Mimics xml2js explicitRoot: false behavior
   */
  private static stripRootElement(obj: XmlValue): XmlValue {
    if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
      return obj;
    }

    const keys = Object.keys(obj);
    // If single root element, return its value
    if (keys.length === 1) {
      return obj[keys[0]!]!;
    }

    return obj;
  }

  /**
   * Parse XML string with xml2js-compatible output
   *
   * @param xml XML string to parse
   * @param options Parsing options
   * @returns Parsed object matching xml2js structure
   * @throws Error if XML exceeds security limits
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public static parse(xml: string, options: ParseOptions = {}): any {
    // Security: Validate input size
    if (xml.length > this.MAX_XML_SIZE) {
      throw new Error(`XML exceeds maximum size of ${this.MAX_XML_SIZE} bytes`);
    }

    // Security: Validate tag count (configurable, 0 = unlimited)
    // Uses simple loop instead of regex to avoid ReDoS vulnerability
    const maxTags = configuration.get<number>(
      "performance.maxXmlTags",
      this.MAX_TAG_COUNT
    );
    if (maxTags > 0) {
      let tagCount = 0;
      for (let i = 0; i < xml.length; i++) {
        if (xml[i] === "<" && xml[i + 1] !== "!" && xml[i + 1] !== "?") {
          tagCount++;
          if (tagCount > maxTags) {
            throw new Error(`XML exceeds maximum tag count of ${maxTags}`);
          }
        }
      }
    }

    // Security: Reject empty input
    if (!xml || xml.trim().length === 0) {
      throw new Error("XML input is empty");
    }

    // Sanitize XML to remove invalid characters
    const sanitizedXml = this.sanitizeXml(xml);

    let result = this.getFxpParser(options.preserveText).parse(sanitizedXml);

    // Strip root element first if explicitRoot: false (before other transforms)
    if (options.explicitRoot === false) {
      result = this.stripRootElement(result);
    }

    // Single-pass transformation for mergeAttrs, camelcase, normalizeArrays
    // Provides 60-70% performance improvement over sequential passes
    if (
      options.mergeAttrs ||
      options.camelcase ||
      options.explicitArray === false
    ) {
      result = this.transform(result, options);
    }

    return result;
  }
}

/**
 * Parse XML with standardized error handling.
 * Wraps XmlParserAdapter.parse() with consistent try/catch/logging pattern.
 *
 * @param content XML string to parse
 * @param transform Function to transform parsed result to desired type
 * @param name Parser name for error messages (e.g., "info", "log")
 * @returns Promise resolving to transformed result
 * @throws Error with formatted message on parse failure
 */
export function parseXml<T>(
  content: string,
  transform: (parsed: unknown) => T,
  name: string
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    try {
      const parsed = XmlParserAdapter.parse(content, DEFAULT_PARSE_OPTIONS);
      resolve(transform(parsed));
    } catch (err) {
      logError(`parse${capitalize(name)} error`, err);
      reject(new Error(`Failed to parse ${name} XML: ${getErrorMessage(err)}`));
    }
  });
}
