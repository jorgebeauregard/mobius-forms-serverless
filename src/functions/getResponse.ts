import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { getPool } from "../../config/db";
import { createErrorResponse } from "../utils";

interface QuestionAnswer {
  question_id: string;
  question_text: string;
  answer_text?: string;
  selected_options?: string[];
  file_url?: string;
}

interface ResponseData {
  response_id: string;
  submitted_at: string;
  form_id: string;
  questions: QuestionAnswer[];
}

export async function getResponse(req: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  // Get response_id from query parameters
  const responseId = req.query.get('response_id');

  if (!responseId) {
    return createErrorResponse(400, "response_id is required");
  }

  try {
    const pool = await getPool();

    // First, get the response and form details
    const responseQuery = `
      SELECT r.id, r.submitted_at, r.form_id
      FROM responses r
      WHERE r.id = @responseId
    `;
    const responseResult = await pool.request()
      .input("responseId", responseId)
      .query(responseQuery);

    if (responseResult.recordset.length === 0) {
      return createErrorResponse(404, "Response not found");
    }

    const response = responseResult.recordset[0];

    // Get all questions for the form and their answers (if any)
    const questionsQuery = `
      SELECT 
        q.id AS question_id,
        qt.question_text,
        a.answer_text,
        a.selected_options,
        a.file_url
      FROM questions q
      JOIN question_translations qt ON q.id = qt.question_id
      JOIN form_question_translations fqt ON qt.id = fqt.question_translation_id
      JOIN form_translations ft ON fqt.form_translation_id = ft.id
      LEFT JOIN answers a ON a.question_id = q.id AND a.response_id = @responseId
      WHERE ft.form_id = @formId
      ORDER BY fqt.position
    `;

    const questionsResult = await pool.request()
      .input("responseId", responseId)
      .input("formId", response.form_id)
      .query(questionsQuery);

    const questions: QuestionAnswer[] = questionsResult.recordset.map(row => ({
      question_id: row.question_id,
      question_text: row.question_text,
      answer_text: row.answer_text || undefined,
      selected_options: row.selected_options ? row.selected_options.split(',') : undefined,
      file_url: row.file_url || undefined
    }));

    const responseData: ResponseData = {
      response_id: response.id,
      submitted_at: response.submitted_at,
      form_id: response.form_id,
      questions
    };

    return {
      status: 200,
      jsonBody: responseData
    };

  } catch (error) {
    context.log("Error retrieving response:", error);
    return createErrorResponse(500, "Internal Server Error: " + error.message);
  }
}

app.http("getResponse", {
  methods: ["GET"],
  authLevel: "anonymous",
  handler: getResponse,
}); 