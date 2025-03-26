import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { getPool } from "../../config/db";
import { createErrorResponse } from "../utils";

interface CreateResponseRequest {
  form_id: string;
  answers: AnswerData[];
}

interface AnswerData {
  question_id: string;
  answer_text?: string;
  selected_options?: string[];
  file_url?: string;
}

export async function createResponse(req: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  // Parse input JSON
  const { form_id, answers } = await req.json() as CreateResponseRequest;

  // Validate required input
  if (!form_id || !answers || !Array.isArray(answers)) {
    return createErrorResponse(400, "form_id and answers array are required");
  }

  try {
    const pool = await getPool();

    // Start a transaction to ensure atomicity
    const transaction = pool.transaction();
    await transaction.begin();

    // 1. Verify the form exists
    const formQuery = "SELECT id FROM forms WHERE id = @formId";
    const formResult = await transaction.request()
      .input("formId", form_id)
      .query(formQuery);
    
    if (formResult.recordset.length === 0) {
      await transaction.rollback();
      return createErrorResponse(404, "Form not found");
    }

    // 2. Create a new response record
    const insertResponseQuery = `
      INSERT INTO responses (form_id)
      OUTPUT INSERTED.id
      VALUES (@formId)
    `;
    const responseResult = await transaction.request()
      .input("formId", form_id)
      .query(insertResponseQuery);
    
    if (responseResult.recordset.length === 0) {
      await transaction.rollback();
      return createErrorResponse(500, "Failed to create response record");
    }
    const responseId = responseResult.recordset[0].id;

    // 3. Process each answer
    for (const answer of answers) {
      const { question_id, answer_text, selected_options, file_url } = answer;

      if (!question_id) {
        await transaction.rollback();
        return createErrorResponse(400, "Each answer must include a question_id");
      }

      // Verify the question exists and belongs to the form
      const questionQuery = `
        SELECT q.id
        FROM questions q
        JOIN question_translations qt ON q.id = qt.question_id
        JOIN form_question_translations fqt ON qt.id = fqt.question_translation_id
        JOIN form_translations ft ON fqt.form_translation_id = ft.id
        WHERE q.id = @questionId AND ft.form_id = @formId
      `;
      const questionResult = await transaction.request()
        .input("questionId", question_id)
        .input("formId", form_id)
        .query(questionQuery);

      if (questionResult.recordset.length === 0) {
        await transaction.rollback();
        return createErrorResponse(404, `Question ${question_id} not found or does not belong to the form`);
      }

      // Insert the answer
      const insertAnswerQuery = `
        INSERT INTO answers (response_id, question_id, answer_text, selected_options, file_url)
        VALUES (@responseId, @questionId, @answerText, @selectedOptions, @fileUrl)
      `;

      await transaction.request()
        .input("responseId", responseId)
        .input("questionId", question_id)
        .input("answerText", answer_text || null)
        .input("selectedOptions", selected_options ? selected_options.join(',') : null)
        .input("fileUrl", file_url || null)
        .query(insertAnswerQuery);
    }

    // Commit the transaction if everything succeeded
    await transaction.commit();

    return {
      status: 201,
      jsonBody: {
        response_id: responseId
      }
    };

  } catch (error) {
    context.log("Error creating answers:", error);
    return createErrorResponse(500, "Internal Server Error: " + error.message);
  }
}

app.http('createResponse', {
  methods: ['POST'],
  authLevel: 'anonymous',
  handler: createResponse,
}); 