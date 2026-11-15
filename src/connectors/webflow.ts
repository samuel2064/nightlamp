export interface WebflowConfig {
  apiKey: string;
  accountId: string;
}

export interface WebflowElement {
  id: string;
  elementId: string;
  dataWfElementId: string | null;
  tagName: string;
  attributes: Record<string, string>;
  textContent: string;
  children: WebflowElement[];
}

export interface WebflowFormField {
  name: string;
  type: string;
  value: string;
  required: boolean;
}

export interface WebflowFormSubmission {
  formId: string;
  fields: WebflowFormField[];
  submitTime: string;
  sourceUrl: string;
}

export interface WebflowNavigationPath {
  pathId: string;
  url: string;
  title: string;
  elementsInteracted: string[];
  timeOnPage: number;
}

export interface WebflowPollResult {
  elements: WebflowElement[];
  forms: WebflowFormSubmission[];
  navigation: WebflowNavigationPath[];
  error: string | null;
}

export async function pollWebflow(config: WebflowConfig): Promise<WebflowPollResult> {
  try {
    const elementUrl = `https://api.webflow.com/v2/elements?apiKey=${config.apiKey}`;
    const formUrl = `https://api.webflow.com/v2/forms?apiKey=${config.apiKey}`;
    const navUrl = `https://api.webflow.com/v2/navigation?apiKey=${config.apiKey}`;

    const [elementResp, formResp, navResp] = await Promise.all([
      fetch(elementUrl),
      fetch(formUrl),
      fetch(navUrl),
    ]);

    if (!elementResp.ok || !formResp.ok || !navResp.ok) {
      return {
        elements: [],
        forms: [],
        navigation: [],
        error: `Webflow API returned errors`,
      };
    }

    const elementsData: any = await elementResp.json();
    const formsData: any = await formResp.json();
    const navData: any = await navResp.json();

    const elements: WebflowElement[] = (elementsData.elements || []).map((el: any) => {
      const attr = el.attributes || {};
      const dataWfElementId = attr['data-wf-element-id'] || null;
      return {
        id: el.id,
        elementId: el.element_id,
        dataWfElementId,
        tagName: el.tag_name,
        attributes: attr,
        textContent: el.text_content || '',
        children: el.children || [],
      };
    });

    const forms: WebflowFormSubmission[] = (formsData.forms || []).map((f: any) => ({
      formId: f.id,
      fields: (f.fields || []).map((field: any) => ({
        name: field.name,
        type: field.type,
        value: field.value || '',
        required: field.required || false,
      })),
      submitTime: new Date().toISOString(),
      sourceUrl: f.source_url || '',
    }));

    const navigation: WebflowNavigationPath[] = (navData.navigation || []).map((n: any) => ({
      pathId: n.path_id,
      url: n.url,
      title: n.page_title,
      elementsInteracted: n.elements_interacted || [],
      timeOnPage: n.time_on_page || 0,
    }));

    return { elements, forms, navigation, error: null };
  } catch (err: any) {
    return { elements: [], forms: [], navigation: [], error: `Webflow poll failed: ${err.message}` };
  }
}

export function detectWebflowElementChanges(
  current: WebflowElement[],
  previous: WebflowElement[]
): { added: WebflowElement[]; removed: WebflowElement[]; modified: WebflowElement[] } {
  const prevMap = new Map((previous || []).map((e) => [e.elementId, e]));
  const currMap = new Map(current.map((e) => [e.elementId, e]));
  const prevIds = new Set((previous || []).map((e) => e.elementId));
  const currIds = new Set(current.map((e) => e.elementId));

  const added: WebflowElement[] = [];
  const removed: WebflowElement[] = [];
  const modified: WebflowElement[] = [];

  // Added: in current but not in previous
  for (const element of current) {
    if (!prevIds.has(element.elementId)) {
      added.push(element);
    }
  }

  // Removed: in previous but not in current
  for (const element of (previous || [])) {
    if (!currIds.has(element.elementId)) {
      removed.push(element);
    }
  }

  // Modified: in both but with different tagName
  for (const element of current) {
    const prev = prevMap.get(element.elementId);
    if (prev && prev.tagName !== element.tagName) {
      modified.push(element);
    }
  }

  return { added, removed, modified };
}

export function detectFormSubmissions(
  current: WebflowFormSubmission[],
  previous: WebflowFormSubmission[]
): WebflowFormSubmission[] {
  const prevSet = new Set(previous.map((f) => f.formId + JSON.stringify(f.fields)));
  return current.filter((form) => !prevSet.has(form.formId + JSON.stringify(form.fields)));
}

export function detectNavigationChanges(
  current: WebflowNavigationPath[],
  previous: WebflowNavigationPath[]
): { newPaths: WebflowNavigationPath[]; leftPages: WebflowNavigationPath[] } {
  const prevSet = new Set(previous.map((p) => p.pathId));
  const currSet = new Set(current.map((c) => c.pathId));

  const newPaths: WebflowNavigationPath[] = [];
  const leftPages: WebflowNavigationPath[] = [];

  for (const path of current) {
    if (!prevSet.has(path.pathId)) {
      newPaths.push(path);
    }
  }

  for (const path of (previous || [])) {
    if (!currSet.has(path.pathId)) {
      leftPages.push(path);
    }
  }

  return { newPaths, leftPages };
}