import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { getPool } from "../../config/db";
import { createErrorResponse } from "../utils";

interface Option {
  optionId: number;
  optionDescription: string;
  position: number;
}

interface Question {
  questionId: number;
  description: string;
  question_type: string;
  required: boolean;
  question_text: string;
  options?: Option[];
  position: number;
}

interface QuestionsResponse {
  form_id: string;
  questions: Question[];
}

export async function getAllQuestions(req: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  // Get parameters from query string
  const username = req.query.get('username');
  const formLanguage = req.query.get('formLanguage');
  const formType = req.query.get('formType');

  if (!username || !formLanguage || !formType) {
    return createErrorResponse(400, "username, formLanguage, and formType are required query parameters");
  }

  try {
    const pool = await getPool();

    // Verify that the user exists and get the userId
    const userQuery = "SELECT id FROM users WHERE email = @username";
    const userResult = await pool.request().input("username", username).query(userQuery);
    if (userResult.recordset.length === 0) {
      return createErrorResponse(404, "User not found");
    }
    const userId = userResult.recordset[0].id;

    // Query to retrieve questions along with their options,
    // filtering by user, form type, and form language
    const query = `
      SELECT
        q.id AS questionId,
        q.description,
        q.question_type,
        q.required,
        qt.question_text,
        qo.id AS optionId,
        qot.option_text AS optionDescription,
        qo.position AS optionPosition,
        fqt.position AS questionPosition,
        f.id AS form_id
      FROM users u
      JOIN forms f ON u.id = f.user_id
      JOIN form_translations ft ON f.id = ft.form_id
      JOIN form_question_translations fqt ON ft.id = fqt.form_translation_id
      JOIN question_translations qt ON fqt.question_translation_id = qt.id
      JOIN questions q ON qt.question_id = q.id
      LEFT JOIN question_options qo ON q.id = qo.question_id
      LEFT JOIN question_option_translations qot ON qo.id = qot.option_id
      WHERE u.id = @userId
        AND f.category = @formType
        AND ft.language = @formLanguage
      ORDER BY fqt.position, qo.position;
    `;
    
    const result = await pool.request()
      .input("userId", userId)
      .input("formType", formType)
      .input("formLanguage", formLanguage)
      .query(query);
    const rows = result.recordset;

    if (rows.length === 0) {
      return createErrorResponse(404, "No questions found for the specified criteria");
    }

    // Get the form_id from the first row
    const form_id = rows[0].form_id;

    // Group rows by questionId and aggregate the options
    const questionsMap: { [key: string]: Question } = {};

    for (const row of rows) {
      const qId = row.questionId;
      if (!questionsMap[qId]) {
        questionsMap[qId] = {
          questionId: row.questionId,
          description: row.description,
          question_type: row.question_type,
          required: row.required,
          question_text: row.question_text,
          options: [],
          position: row.questionPosition
        };
      }
      
      // Only add the option if optionId is not null (due to LEFT JOIN)
      if (row.optionId) {
        questionsMap[qId].options.push({
          optionId: row.optionId,
          optionDescription: row.optionDescription,
          position: row.optionPosition
        });
      }
    }

    // Convert the map to an array of questions and sort by position
    const questions: Question[] = Object.values(questionsMap)
      .map(question => ({
        ...question,
        options: question.options?.sort((a, b) => a.position - b.position) || []
      }))
      .sort((a, b) => a.position - b.position);
    
    const response: QuestionsResponse = {
      form_id,
      questions
    };

    return {
      status: 200,
      jsonBody: response
    };
  } catch (error) {
    context.log("Error retrieving questions:", error);
    return createErrorResponse(500, "Internal Server Error: " + error.message);
  }
}

app.http("getAllQuestions", {
  methods: ["GET"],
  authLevel: "anonymous",
  handler: getAllQuestions,
});